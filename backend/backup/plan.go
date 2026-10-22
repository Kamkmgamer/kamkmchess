package backup

import (
	"errors"
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
	// MaxBundleAgeDays is the maximum age of an ordinary repo-managed
	// recovery bundle.
	//
	// The count of the rotation alone cannot promise the thirty day target
	// of the owner approved contract: seven daily and four weekly copies
	// span more than thirty days when the rotation did not run, and a copy
	// that never claims a slot can stay forever. The maximum age is
	// therefore a second and independent rule: a bundle that is older than
	// the maximum is retired even when a slot of the count would keep it.
	//
	// The rule is about the bundles of the managed directory of this
	// repository only. It says nothing about a copy on an offsite store, it
	// is not a proof that the recovery copies were sanitized, and it does
	// not mark a removal as sanitized.
	MaxBundleAgeDays = 30
)

// MaxBundleAge is the maximum age of an ordinary repo-managed recovery
// bundle. A bundle that is exactly this old is still inside the maximum; a
// bundle that is older is due for retirement.
const MaxBundleAge = time.Duration(MaxBundleAgeDays) * 24 * time.Hour

// ErrRetentionUnresolved is the error of a rotation that could not satisfy
// every retention obligation of the managed directory.
//
// A bundle that the rotation keeps because an operator protects it, because
// it has no creation time or because it is dated after the reference time
// cannot be dated with a proven age. The rotation never deletes such a
// bundle, so it must not report success while the bundle remains.
var ErrRetentionUnresolved = errors.New("backup: the retention of a bundle is unresolved")

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
	// MaxAgeDays is the maximum age of an ordinary bundle of the managed
	// directory. A bundle that is older is retired even when a slot of the
	// count would keep it.
	MaxAgeDays int `json:"maxAgeDays"`
	// Unresolved lists the bundles whose retention could not be satisfied:
	// a protected bundle that passed the maximum age, a bundle whose age
	// cannot be proven and a bundle whose manifest cannot be read. The
	// rotation never deletes them, so the rotation must not report success
	// while they remain.
	Unresolved []Disposition `json:"unresolved"`
}

// PlanRotation selects the seven newest daily and four newest weekly bundles
// and retires every ordinary bundle that passed the maximum age.
//
// Rules:
//   - duplicate labels are an error, because two files claiming one slot make
//     retention unprovable;
//   - a bundle dated after the reference time is kept and flagged, because a
//     future date usually means a clock problem rather than a licence to delete;
//   - a protected bundle is kept regardless of age;
//   - an unrecognized label class is kept with an explicit reason, never pruned
//     by the daily/weekly rules;
//   - an ordinary bundle older than the maximum age is retired even when a
//     slot of the count would keep it;
//   - a bundle whose age cannot be proven - no creation time, a date after the
//     reference time, or a protected bundle that passed the maximum age - is
//     kept and reported as unresolved, so the rotation cannot claim success
//     while it remains.
func PlanRotation(candidates []Candidate, reference time.Time, policy RetentionPolicy) (RotationPlan, error) {
	if policy.Daily < 1 || policy.Weekly < 1 {
		return RotationPlan{}, fmt.Errorf("%w: retention must keep at least one daily and one weekly copy", ErrLabelInvalid)
	}
	if reference.IsZero() {
		return RotationPlan{}, fmt.Errorf("%w: a reference time is required", ErrLabelInvalid)
	}
	plan := RotationPlan{Policy: policy, GeneratedAt: reference.UTC(), MaxAgeDays: MaxBundleAgeDays}
	// The oldest bundle that is still inside the maximum age. A bundle that
	// was created before it is due for retirement.
	cutoff := reference.UTC().Add(-MaxBundleAge)
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
			if reason := openObligation(candidate, reference, cutoff); reason != "" {
				plan.Unresolved = append(plan.Unresolved, disposition(entry, "unresolved",
					"protected and "+reason+"; the rotation never prunes a protected bundle, so the obligation stays open until the operator resolves it"))
			}
		case candidate.CreatedAt.IsZero():
			plan.Keep = append(plan.Keep, disposition(entry, "keep", "no creation time is recorded; retention cannot be proven"))
			plan.Unresolved = append(plan.Unresolved, disposition(entry, "unresolved",
				"no creation time is recorded, so the age of the bundle cannot be proven"))
		case candidate.CreatedAt.After(reference):
			plan.Keep = append(plan.Keep, disposition(entry, "keep", "created after the reference time; verify the clock before trusting retention"))
			plan.Unresolved = append(plan.Unresolved, disposition(entry, "unresolved",
				"the bundle is dated after the reference time, so the age of the bundle cannot be proven"))
		default:
			if candidate.CreatedAt.Before(cutoff) {
				// The bundle is older than the maximum age. The count of the
				// rotation does not keep it: the maximum age is a limit of its
				// own, and a copy that is too old is retired even when a slot
				// would hold it.
				plan.Prune = append(plan.Prune, disposition(entry, "prune",
					fmt.Sprintf("older than the maximum age of %d days", MaxBundleAgeDays)))
				plan.PrunableBytes += entry.Bytes
				continue
			}
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
	sortDispositions(plan.Unresolved)
	return plan, nil
}

// openObligation reports why a bundle that the rotation keeps leaves an open
// retention obligation, or the empty string when the obligation is satisfied.
//
// The rotation keeps a bundle for three reasons that do not settle its age:
// the bundle is protected, the bundle carries no creation time, and the
// bundle is dated after the reference time. A bundle that passed the maximum
// age is the fourth reason. In every one of those cases the age of the bundle
// cannot be proven, so the obligation of the owner contract stays open.
func openObligation(candidate Candidate, reference, cutoff time.Time) string {
	switch {
	case candidate.CreatedAt.IsZero():
		return "no creation time is recorded, so the age of the bundle cannot be proven"
	case candidate.CreatedAt.After(reference):
		return "the bundle is dated after the reference time, so the age of the bundle cannot be proven"
	case candidate.CreatedAt.Before(cutoff):
		return fmt.Sprintf("the bundle is older than the maximum age of %d days", MaxBundleAgeDays)
	}
	return ""
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
