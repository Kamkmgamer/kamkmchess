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

// The maximum age is the limit of the owner contract: a bundle that is older
// than thirty days is due, and a bundle that is exactly thirty days old is
// still inside the limit. The boundary is the one the contract can be read
// against, so it is proved here to the second.
func TestPlanRotationEnforcesTheMaximumAgeOfThirtyDays(t *testing.T) {
	reference := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	if MaxBundleAgeDays != 30 || MaxBundleAge != 30*24*time.Hour {
		t.Fatalf("the maximum age is %d days (%s), want 30 days", MaxBundleAgeDays, MaxBundleAge)
	}
	candidates := []Candidate{
		{Path: "one-second-inside", Label: "daily-2026-10-03", CreatedAt: reference.Add(-MaxBundleAge + time.Second), Bytes: 30},
		{Path: "exactly-thirty-days", Label: "daily-2026-10-02", CreatedAt: reference.Add(-MaxBundleAge), Bytes: 10},
		{Path: "one-second-too-old", Label: "daily-2026-10-01", CreatedAt: reference.Add(-MaxBundleAge - time.Second), Bytes: 20},
	}
	// The count is wide enough to keep every one of the three copies, so the
	// only rule that can retire one of them is the maximum age.
	plan, err := PlanRotation(candidates, reference, RetentionPolicy{Daily: 7, Weekly: 1})
	if err != nil {
		t.Fatal(err)
	}
	if plan.MaxAgeDays != 30 {
		t.Fatalf("the plan does not name the maximum age: %+v", plan)
	}
	kept := map[string]bool{}
	for _, item := range plan.Keep {
		kept[item.Path] = true
	}
	for _, path := range []string{"exactly-thirty-days", "one-second-inside"} {
		if !kept[path] {
			t.Fatalf("%s is inside the maximum age and must be kept: %+v", path, plan)
		}
	}
	if len(plan.Prune) != 1 || plan.Prune[0].Path != "one-second-too-old" {
		t.Fatalf("only the copy that passed the maximum age may be retired: %+v", plan.Prune)
	}
	if !contains(plan.Prune[0].Reason, "maximum age") {
		t.Fatalf("the retirement reason does not name the maximum age: %q", plan.Prune[0].Reason)
	}
	if plan.PrunableBytes != 20 {
		t.Fatalf("prunable bytes = %d, want 20", plan.PrunableBytes)
	}
	if len(plan.Unresolved) != 0 {
		t.Fatalf("an ordinary bundle of the managed directory is not unresolved: %+v", plan.Unresolved)
	}
}

// The count of the rotation is not a promise about the age of a copy: a
// bundle that is older than the maximum age is retired even when a slot of
// the count is free.
func TestPlanRotationRetiresAnOldBundleEvenWhenASlotIsFree(t *testing.T) {
	reference := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	candidates := []Candidate{
		{Path: "old-weekly", Label: "weekly-2026-W40", CreatedAt: reference.AddDate(0, 0, -40), Bytes: 100},
		{Path: "new-weekly", Label: "weekly-2026-W44", CreatedAt: reference.AddDate(0, 0, -1), Bytes: 100},
	}
	plan, err := PlanRotation(candidates, reference, RetentionPolicy{Daily: 1, Weekly: 4})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Prune) != 1 || plan.Prune[0].Path != "old-weekly" {
		t.Fatalf("the copy that passed the maximum age must be retired: %+v", plan.Prune)
	}
	if len(plan.Unresolved) != 0 {
		t.Fatalf("the retirement of an ordinary copy resolves the retention: %+v", plan.Unresolved)
	}
}

// A protected bundle is never deleted. When it is older than the maximum age
// the obligation stays open, and the rotation has to say so instead of
// reporting a success it cannot prove.
func TestPlanRotationKeepsAProtectedOldBundleAndReportsItAsUnresolved(t *testing.T) {
	reference := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	candidates := []Candidate{
		{Path: "protected-old", Label: "weekly-2026-W40", CreatedAt: reference.AddDate(0, 0, -40), Protected: true},
		{Path: "ordinary-old", Label: "weekly-2026-W41", CreatedAt: reference.AddDate(0, 0, -40)},
	}
	plan, err := PlanRotation(candidates, reference, RetentionPolicy{Daily: 1, Weekly: 4})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range plan.Prune {
		if item.Path == "protected-old" {
			t.Fatalf("a protected bundle is never retired: %+v", plan.Prune)
		}
	}
	kept := map[string]bool{}
	for _, item := range plan.Keep {
		kept[item.Path] = true
	}
	if !kept["protected-old"] {
		t.Fatalf("the protected bundle is kept: %+v", plan.Keep)
	}
	if len(plan.Unresolved) != 1 || plan.Unresolved[0].Path != "protected-old" {
		t.Fatalf("the protected old bundle has to be reported as unresolved: %+v", plan.Unresolved)
	}
	if !contains(plan.Unresolved[0].Reason, "protected") || !contains(plan.Unresolved[0].Reason, "maximum age") {
		t.Fatalf("the unresolved reason does not explain the obligation: %q", plan.Unresolved[0].Reason)
	}
}

// A bundle whose age cannot be proven leaves the obligation open, whether it
// is protected or not: a bundle without a creation time and a bundle dated
// after the reference time are both kept, and both are reported.
func TestPlanRotationReportsUnprovableAgesAsUnresolved(t *testing.T) {
	reference := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	candidates := []Candidate{
		{Path: "undated", Label: "daily-2026-10-29"},
		{Path: "future", Label: "daily-2026-11-05", CreatedAt: reference.AddDate(0, 0, 4)},
		{Path: "protected-undated", Label: "daily-2026-10-28", Protected: true},
	}
	plan, err := PlanRotation(candidates, reference, RetentionPolicy{Daily: 7, Weekly: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Prune) != 0 {
		t.Fatalf("a bundle of an unprovable age is never retired: %+v", plan.Prune)
	}
	unresolved := map[string]string{}
	for _, item := range plan.Unresolved {
		unresolved[item.Path] = item.Reason
	}
	for _, path := range []string{"undated", "future", "protected-undated"} {
		if _, found := unresolved[path]; !found {
			t.Fatalf("%s has to be reported as unresolved: %+v", path, plan.Unresolved)
		}
	}
	if !contains(unresolved["undated"], "cannot be proven") {
		t.Fatalf("the unresolved reason does not explain the missing proof: %q", unresolved["undated"])
	}
	if !contains(unresolved["future"], "cannot be proven") {
		t.Fatalf("the unresolved reason does not explain the missing proof: %q", unresolved["future"])
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
