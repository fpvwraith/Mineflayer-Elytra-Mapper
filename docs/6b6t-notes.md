# 6b6t notes

Behaviour of 6b6t-style anarchy servers that shapes how the mapper works. Other servers differ: set
`server.directConnect`, `server.lobbyBox` and the `mapping.*` home settings to match.

- **Proxy lobby.** You connect to a proxy lobby first (around x 150 to 450, z 280 to 520 on 6b6t), and a portal moves you
  to the main server. The mapper detects the lobby by position, walks into the portal, freezes physics for the transfer
  and waits for the main server. Movement packets are held back while the connection is reconfiguring, because one that
  lands mid-transfer gets the client kicked. Nothing is recorded until the bot is on the main server.
- **Corrupt chunks.** Some builds produce chunks that a vanilla client tolerates but mineflayer's parser rejects. The
  mapper logs "skipped an unparseable packet" and stays connected. A 45 second no-packet watchdog catches a dead socket.
- **No `/home` near spawn.** `/home` does not work within 5,000 blocks of 0,0 (`mapping.noHomeRadius`). The mapper
  therefore uses a far base outside that radius for its bed and ender chest, and commutes to the launch platform with
  `/home`. Inside the radius the bot has to reach a chest on foot or `/kill` to reset. `/home` has a cooldown (about five
  minutes with a rank perk, `mapping.homeCooldownSec`) and a short warm-up, and `/kill` has a cooldown of roughly half a
  minute, so the commute waits and retries instead of spamming.
- **Elytra durability.** An elytra loses one durability per second of flight (432 maximum), about 7 minutes from new; each
  level of Unbreaking multiplies that by about (level + 1). The flight uses mineflayer's firework-boost physics, which
  does not consume rockets. Every run ends with a broken elytra, a fall and a respawn on the far bed, so budget elytras:
  the ender chest should hold shulker boxes of them.
- **Cruise altitude.** Flying at Y 360 to 450 means nothing can be built in the way (the build limit is Y 319).
- **Anti-bot / captcha kicks.** The server sometimes kicks an account with an anti-bot message until a human completes a
  verification by logging in with a real client. The mapper recognises the kick, logs what happened, emits a `kicked`
  event with `kind: 'captcha'`, and stops reconnecting for `connection.captchaCooldownMin` minutes (or until restart if
  that is 0). It never tries to solve the verification, and neither should anything you build on it.
- **Connection limiters.** "Logging in too fast", "already online" and similar kicks raise the reconnect delay to at least
  `connection.rateLimitCooldownSec`. The backoff doubles to a cap and only resets after a connection survives 90 seconds on
  the main server, so a crash loop slows itself down.
- **Accounts per address.** 6b6t allows 3 accounts per IPv4 address. Running one mapper from your own connection is
  within that; do not run more than the server allows.
- **Respect the rules.** Use an account you can afford to lose, follow the server's rules, and do not map areas you must
  not. The mapper reads terrain from the chunks the server sends. It does not grief, raid or attack; the only blocks it touches are your own ender chest and a shulker box it places to unpack elytras.
