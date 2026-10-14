package api

// gameDefaultRace is the race target a game measures to when neither the match
// nor its division sets one: games for the win-measured disciplines, points for
// the ball-measured ones. This is the server's copy of the game catalog — the
// same list as the front end's `GAMES[*].defaultRaceTo` in app.js (`server`
// keys stay snake_case as in `validGames`, the console uses its own ids).
var gameDefaultRace = map[string]int{
	"15ball_rotation": 25,
	"straight_14_1":   100,
	"8ball":           7,
	"9ball":           7,
	"10ball":          7,
	"one_pocket":      3,
	"bank_pool":       5,
}

// rotationDefaultRace is the fallback for an unknown or empty game id: the
// rotation default, matching the console's `GAMES.fifteenBall`.
const rotationDefaultRace = 25

// gameDefaultRaceTo returns the race target for a game id. An unknown or empty
// game reads as the 15-ball rotation default (25).
func gameDefaultRaceTo(game string) int {
	if n, ok := gameDefaultRace[game]; ok {
		return n
	}
	return rotationDefaultRace
}

// resolveRaceTo resolves a match's race target from its three layers — the
// per-match override, the division's target, then the game's own default — and
// returns the number together with the name of the layer that supplied it:
// "match", "division" or "default". A nil override means that layer is unset.
func resolveRaceTo(matchOverride, divisionOverride *int, game string) (int, string) {
	if matchOverride != nil {
		return *matchOverride, "match"
	}
	if divisionOverride != nil {
		return *divisionOverride, "division"
	}
	return gameDefaultRaceTo(game), "default"
}
