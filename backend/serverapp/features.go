package serverapp

import "strings"

// PublicFeatures holds the independent rollout switches of the two new
// online surfaces.
//
// Both switches default to off. A closed surface is not mounted, so its
// routes answer 404. The switches are independent: one surface can be open
// while the other stays closed.
type PublicFeatures struct {
	// FriendsEnabled opens the friend invitation and rematch routes.
	FriendsEnabled bool
	// QueueEnabled opens the public queue routes.
	QueueEnabled bool
}

// boolFlag reads an optional boolean switch.
//
// An absent or unparsable value is false. A switch never opens a surface
// because of a typo, and the feature answer never claims a surface is open
// when the service did not open it.
func boolFlag(getenv func(string) string, key string) bool {
	switch strings.ToLower(strings.TrimSpace(getenv(key))) {
	case "1", "true", "yes", "on", "enabled":
		return true
	default:
		return false
	}
}
