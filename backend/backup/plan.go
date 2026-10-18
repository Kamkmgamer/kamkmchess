package backup

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Rotation labels are what make the approved "seven daily, four weekly"
// rotation reviewable without opening a file. A daily label is
// "daily-YYYY-MM-DD" and a weekly label is "weekly-YYYY-Www" (ISO week).
const (
	DailyLabelPrefix  = "daily-"
	WeeklyLabelPrefix = "weekly-"
	// DefaultDailyCopies and DefaultWeeklyCopies are the approved MVP rotation.
	DefaultDailyCopies  = 7
	DefaultWeeklyCopies = 4
)

// RetentionPolicy is the reviewed retention target. Zero is rejected so a
// misconfigured policy cannot silently delete everything.
type RetentionPolicy struct {
	Daily  int `json:"daily"`
	Weekly int `json:"weekly"`
}

// DefaultRetention returns the approved MVP rotation.
func DefaultRetention() RetentionPolicy {
	return RetentionPolicy{Daily: DefaultDailyCopies, Weekly: DefaultWeeklyCopies}
}

// ParseLabel validates a rotation label and reports whether it is a daily or a
// weekly copy. An unrecognized label is an error rather than a silent
// classification, so a manual "before-upgrade" export is never pruned by a
// rule written for the daily/weekly schedule.
func ParseLabel(label string) (RotationClass, error) {
	switch {
	case len(label) > len(DailyLabelPrefix) && label[:len(DailyLabelPrefix)] == DailyLabelPrefix:
		day := label[len(DailyLabelPrefix):]
		if _, err := time.Parse(time.DateOnly, day); err != nil {
			return "", fmt.Errorf("%w: %q is not daily-YYYY-MM-DD", ErrLabelInvalid, label)
		}
		return RotationDaily, nil
	case len(label) > len(WeeklyLabelPrefix) && label[:len(WeeklyLabelPrefix)] == WeeklyLabelPrefix:
		if !validWeeklyPart(label[len(WeeklyLabelPrefix):]) {
			return "", fmt.Errorf("%w: %q is not weekly-YYYY-Www", ErrLabelInvalid, label)
		}
		return RotationWeekly, nil
	default:
		return "", fmt.Errorf("%w: %q is neither %sYYYY-MM-DD nor %sYYYY-Www", ErrLabelInvalid, label, DailyLabelPrefix, WeeklyLabelPrefix)
	}
}

// RotationClass identifies which retention slot a bundle occupies.
type RotationClass string

const (
	RotationDaily  RotationClass = "daily"
	RotationWeekly RotationClass = "weekly"
)

// validWeeklyPart checks "YYYY-Www" against the real ISO week count, because a
// layout string cannot express an ISO week directly.
func validWeeklyPart(part string) bool {
	yearText, weekText, found := strings.Cut(part, "-W")
	if !found || len(yearText) != 4 || len(weekText) != 2 {
		return false
	}
	for _, text := range []string{yearText, weekText} {
		for _, character := range text {
			if character < '0' || character > '9' {
				return false
			}
		}
	}
	year, yearErr := strconv.Atoi(yearText)
	week, weekErr := strconv.Atoi(weekText)
	if yearErr != nil || weekErr != nil || year < 1 || week < 1 {
		return false
	}
	// December 28 is always in the last ISO week of its year.
	_, weeks := time.Date(year, time.December, 28, 0, 0, 0, 0, time.UTC).ISOWeek()
	return week <= weeks
}

// Candidate is one sealed bundle known to the rotation planner. Nothing here
// opens a file; the caller inspects or verifies the bundle separately.
type Candidate struct {
	Path      string        `json:"path"`
	Label     string        `json:"label"`
	Class     RotationClass `json:"class"`
	CreatedAt time.Time     `json:"createdAt"`
	Bytes     int64         `json:"bytes"`
	// Protected marks a bundle that an operator or a completed restore still
	// needs. A protected bundle is never pruned.
	Protected bool `json:"protected"`
}

// Disposition is the operator-visible reason a candidate is kept or pruned.
type Disposition struct {
	Path   string        `json:"path"`
	Label  string        `json:"label"`
	Class  RotationClass `json:"class"`
	Action string        `json:"action"`
	Reason string        `json:"reason"`
}

// RotationPlan is the complete, reviewable decision. It is never applied
// implicitly: scripts and humans apply it deliberately.
type RotationPlan struct {
	Keep          []Disposition   `json:"keep"`
	Prune         []Disposition   `json:"prune"`
	Policy        RetentionPolicy `json:"policy"`
	GeneratedAt   time.Time       `json:"generatedAt"`
	PrunableBytes int64           `json:"prunableBytes"`
}

// PlanRotation selects the seven newest daily and four newest weekly bundles.
//
// Rules:
//   - duplicate labels are an error, because two files claiming one slot make
//     retention unprovable;
//   - a bundle dated after the reference time is kept and flagged, because a
//     future date usually means a clock problem rather than a licence to delete;
//   - a protected bundle is kept regardless of age;
//   - an unrecognized label class is kept with an explicit reason, never pruned
//     by the daily/weekly rules.
func PlanRotation(candidates []Candidate, reference time.Time, policy RetentionPolicy) (RotationPlan, error) {
	if policy.Daily < 1 || policy.Weekly < 1 {
		return RotationPlan{}, fmt.Errorf("%w: retention must keep at least one daily and one weekly copy", ErrLabelInvalid)
	}
	if reference.IsZero() {
		return RotationPlan{}, fmt.Errorf("%w: a reference time is required", ErrLabelInvalid)
	}
	plan := RotationPlan{Policy: policy, GeneratedAt: reference.UTC()}
	seen := map[string]bool{}
	daily := make([]Candidate, 0, len(candidates))
	weekly := make([]Candidate, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate.Label == "" || seen[candidate.Label] {
			return RotationPlan{}, fmt.Errorf("%w: duplicate or empty label %q", ErrLabelInvalid, candidate.Label)
		}
		seen[candidate.Label] = true
		class, err := ParseLabel(candidate.Label)
		if err != nil {
			return RotationPlan{}, err
		}
		entry := candidate
		entry.Class = class
		switch {
		case candidate.Protected:
			plan.Keep = append(plan.Keep, disposition(entry, "keep", "protected: an operator or a completed restore still needs this copy"))
		case candidate.CreatedAt.IsZero():
			plan.Keep = append(plan.Keep, disposition(entry, "keep", "no creation time is recorded; retention cannot be proven"))
		case candidate.CreatedAt.After(reference):
			plan.Keep = append(plan.Keep, disposition(entry, "keep", "created after the reference time; verify the clock before trusting retention"))
		default:
			switch class {
			case RotationDaily:
				daily = append(daily, entry)
			case RotationWeekly:
				weekly = append(weekly, entry)
			}
		}
	}
	sortNewestFirst(daily)
	sortNewestFirst(weekly)
	keptDaily := 0
	for index, entry := range daily {
		if keptDaily < policy.Daily {
			keptDaily++
			plan.Keep = append(plan.Keep, disposition(entry, "keep", fmt.Sprintf("daily slot %d of %d", keptDaily, policy.Daily)))
			continue
		}
		plan.Prune = append(plan.Prune, disposition(entry, "prune", fmt.Sprintf("daily slot %d exceeds the %d-copy target", index+1, policy.Daily)))
		plan.PrunableBytes += entry.Bytes
	}
	keptWeekly := 0
	for index, entry := range weekly {
		if keptWeekly < policy.Weekly {
			keptWeekly++
			plan.Keep = append(plan.Keep, disposition(entry, "keep", fmt.Sprintf("weekly slot %d of %d", keptWeekly, policy.Weekly)))
			continue
		}
		plan.Prune = append(plan.Prune, disposition(entry, "prune", fmt.Sprintf("weekly slot %d exceeds the %d-copy target", index+1, policy.Weekly)))
		plan.PrunableBytes += entry.Bytes
	}
	sortDispositions(plan.Keep)
	sortDispositions(plan.Prune)
	return plan, nil
}

func disposition(candidate Candidate, action, reason string) Disposition {
	return Disposition{Path: candidate.Path, Label: candidate.Label, Class: candidate.Class, Action: action, Reason: reason}
}

func sortNewestFirst(candidates []Candidate) {
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].CreatedAt.Equal(candidates[j].CreatedAt) {
			return candidates[i].Label > candidates[j].Label
		}
		return candidates[i].CreatedAt.After(candidates[j].CreatedAt)
	})
}

func sortDispositions(items []Disposition) {
	sort.Slice(items, func(i, j int) bool {
		if items[i].Class != items[j].Class {
			return items[i].Class < items[j].Class
		}
		if items[i].Label != items[j].Label {
			return items[i].Label > items[j].Label
		}
		return items[i].Path < items[j].Path
	})
}

// DailyLabel and WeeklyLabel build the canonical labels for a seal operation.
func DailyLabel(at time.Time) string { return DailyLabelPrefix + at.UTC().Format(time.DateOnly) }

// WeeklyLabel returns the ISO week label for the week containing at.
func WeeklyLabel(at time.Time) string {
	year, week := at.UTC().ISOWeek()
	return fmt.Sprintf("%s%04d-W%02d", WeeklyLabelPrefix, year, week)
}
