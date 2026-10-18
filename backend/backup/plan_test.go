package backup

import (
	"errors"
	"testing"
	"time"
)

func day(number int) time.Time {
	return time.Date(2026, 10, number, 6, 0, 0, 0, time.UTC)
}

func TestParseLabelAcceptsOnlyRotationLabels(t *testing.T) {
	for _, label := range []string{"daily-2026-10-18", "weekly-2026-W42"} {
		if _, err := ParseLabel(label); err != nil {
			t.Fatalf("%q was rejected: %v", label, err)
		}
	}
	for _, label := range []string{"", "daily-", "daily-2026-13-01", "weekly-2026-42", "manual-export", "daily-2026-10-18T00:00:00Z", "monthly-2026-10"} {
		if _, err := ParseLabel(label); !errors.Is(err, ErrLabelInvalid) {
			t.Fatalf("%q was accepted as a rotation label: %v", label, err)
		}
	}
}

func TestDailyAndWeeklyLabels(t *testing.T) {
	if got := DailyLabel(day(18)); got != "daily-2026-10-18" {
		t.Fatalf("DailyLabel = %q", got)
	}
	// 2026-01-01 is a Thursday, so it belongs to ISO week 1 of 2026.
	if got := WeeklyLabel(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)); got != "weekly-2026-W01" {
		t.Fatalf("WeeklyLabel = %q", got)
	}
	if got := WeeklyLabel(time.Date(2026, 12, 31, 12, 0, 0, 0, time.UTC)); got != "weekly-2026-W53" {
		t.Fatalf("WeeklyLabel at the year boundary = %q", got)
	}
}

func TestPlanRotationKeepsSevenDailyAndFourWeekly(t *testing.T) {
	reference := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	var candidates []Candidate
	for index := 1; index <= 10; index++ {
		at := reference.AddDate(0, 0, -index)
		candidates = append(candidates, Candidate{Path: "daily-" + at.Format(time.DateOnly), Label: "daily-" + at.Format(time.DateOnly), CreatedAt: at, Bytes: 100})
	}
	for index := 1; index <= 6; index++ {
		at := reference.AddDate(0, 0, -7*index)
		candidates = append(candidates, Candidate{Path: "weekly-" + WeeklyLabel(at), Label: WeeklyLabel(at), CreatedAt: at, Bytes: 100})
	}
	plan, err := PlanRotation(candidates, reference, DefaultRetention())
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if len(plan.Keep) != 11 || len(plan.Prune) != 5 {
		t.Fatalf("keep=%d prune=%d, want 11 kept and 5 pruned", len(plan.Keep), len(plan.Prune))
	}
	if plan.PrunableBytes != 500 {
		t.Fatalf("prunable bytes = %d, want 500", plan.PrunableBytes)
	}
	keptDaily := map[string]bool{}
	for _, item := range plan.Keep {
		if item.Class != RotationDaily {
			continue
		}
		keptDaily[item.Label] = true
	}
	wantDaily := []string{"daily-2026-10-25", "daily-2026-10-26", "daily-2026-10-27", "daily-2026-10-28", "daily-2026-10-29", "daily-2026-10-30", "daily-2026-10-31"}
	if len(keptDaily) != len(wantDaily) {
		t.Fatalf("kept daily copies %v, want the seven newest %v", keptDaily, wantDaily)
	}
	for _, label := range wantDaily {
		if !keptDaily[label] {
			t.Fatalf("%s should have been kept: %+v", label, plan.Keep)
		}
	}
	prunedDaily := []string{"daily-2026-10-24", "daily-2026-10-23"}
	for _, label := range prunedDaily {
		if keptDaily[label] {
			t.Fatalf("%s is outside the seven-copy daily target and must be pruned", label)
		}
	}
	if plan.Prune[0].Class != RotationDaily && plan.Prune[0].Reason == "" {
		t.Fatalf("prune entries must carry a reason: %+v", plan.Prune[0])
	}
}

func TestPlanRotationIsDeterministic(t *testing.T) {
	reference := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	candidates := []Candidate{
		{Path: "b", Label: "daily-2026-10-30", CreatedAt: reference.AddDate(0, 0, -2)},
		{Path: "a", Label: "daily-2026-10-29", CreatedAt: reference.AddDate(0, 0, -2)},
		{Path: "c", Label: "daily-2026-10-31", CreatedAt: reference.AddDate(0, 0, -1)},
	}
	first, err := PlanRotation(candidates, reference, RetentionPolicy{Daily: 2, Weekly: 1})
	if err != nil {
		t.Fatal(err)
	}
	reversed := []Candidate{candidates[2], candidates[1], candidates[0]}
	second, err := PlanRotation(reversed, reference, RetentionPolicy{Daily: 2, Weekly: 1})
	if err != nil {
		t.Fatal(err)
	}
	if first.Keep[0].Label != second.Keep[0].Label || len(first.Prune) != len(second.Prune) || first.Prune[0].Label != second.Prune[0].Label {
		t.Fatalf("rotation order depends on input order: %+v vs %+v", first, second)
	}
}

func TestPlanRotationRejectsAmbiguousRetention(t *testing.T) {
	reference := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	duplicate := []Candidate{
		{Path: "a", Label: "daily-2026-10-31", CreatedAt: reference.AddDate(0, 0, -1)},
		{Path: "b", Label: "daily-2026-10-31", CreatedAt: reference.AddDate(0, 0, -2)},
	}
	if _, err := PlanRotation(duplicate, reference, DefaultRetention()); !errors.Is(err, ErrLabelInvalid) {
		t.Fatalf("duplicate labels accepted: %v", err)
	}
	if _, err := PlanRotation(duplicate, reference, RetentionPolicy{Daily: 0, Weekly: 4}); !errors.Is(err, ErrLabelInvalid) {
		t.Fatalf("zero retention accepted: %v", err)
	}
	if _, err := PlanRotation(duplicate, reference, DefaultRetention()); err == nil {
		t.Fatal("expected the duplicate label error")
	}
}

func TestPlanRotationProtectsAndKeepsUnprovableCopies(t *testing.T) {
	reference := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	policy := RetentionPolicy{Daily: 1, Weekly: 1}
	candidates := []Candidate{
		{Path: "newest", Label: "daily-2026-10-31", CreatedAt: reference.AddDate(0, 0, -1)},
		{Path: "protected", Label: "daily-2026-10-30", CreatedAt: reference.AddDate(0, 0, -2), Protected: true},
		{Path: "future", Label: "daily-2026-11-05", CreatedAt: reference.AddDate(0, 0, 4)},
		{Path: "undated", Label: "daily-2026-10-29"},
		{Path: "weekly-old", Label: "weekly-2026-W40", CreatedAt: reference.AddDate(0, 0, -21)},
		{Path: "weekly-new", Label: "weekly-2026-W44", CreatedAt: reference.AddDate(0, 0, -1)},
	}
	plan, err := PlanRotation(candidates, reference, policy)
	if err != nil {
		t.Fatal(err)
	}
	reasons := map[string]string{}
	for _, item := range plan.Keep {
		reasons[item.Path] = item.Reason
	}
	if len(plan.Prune) != 1 || plan.Prune[0].Path != "weekly-old" || plan.Prune[0].Class != RotationWeekly {
		t.Fatalf("prune = %+v", plan.Prune)
	}
	for _, path := range []string{"protected", "future", "undated", "newest", "weekly-new"} {
		if _, kept := reasons[path]; !kept {
			t.Fatalf("%s should have been kept: %+v", path, plan)
		}
	}
	if !contains(reasons["protected"], "protected") || !contains(reasons["future"], "clock") || !contains(reasons["undated"], "no creation time") {
		t.Fatalf("retention reasons are not reviewable: %+v", reasons)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (haystack == needle || indexOf(haystack, needle) >= 0)
}

func indexOf(haystack, needle string) int {
	for index := 0; index+len(needle) <= len(haystack); index++ {
		if haystack[index:index+len(needle)] == needle {
			return index
		}
	}
	return -1
}
