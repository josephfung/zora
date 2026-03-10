# Signal Secure Channel Setup

Zora supports Signal as an encrypted inbound/outbound channel. This lets you message Zora over Signal and get responses — end-to-end encrypted by the Signal Protocol.

## Prerequisites

- A phone number that can receive SMS or voice calls (VoIP numbers work — Google Voice, MySudo, Agent Phone, etc.)
- Java 21+ (`brew install openjdk@25` or similar)
- `signal-cli` ≥ 0.14.1 (see Installation below)

## Installation

### signal-cli

Homebrew may be behind. Install 0.14.1+ directly:

```bash
# Download the pre-built distribution
VERSION=0.14.1
curl -L "https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}.tar.gz" \
  -o /tmp/signal-cli-${VERSION}.tar.gz
tar xzf /tmp/signal-cli-${VERSION}.tar.gz -C /tmp/

# Install to user bin (no sudo needed)
mkdir -p ~/.local/bin
cp /tmp/signal-cli-${VERSION}/bin/signal-cli ~/.local/bin/signal-cli
chmod +x ~/.local/bin/signal-cli

# Verify
JAVA_HOME=$(brew --prefix openjdk@25) ~/.local/bin/signal-cli --version
# → signal-cli 0.14.1
```

Add to your shell profile so `JAVA_HOME` is always set:

```bash
# ~/.zshrc or ~/.bash_profile
export JAVA_HOME=$(brew --prefix openjdk@25)
export PATH="$HOME/.local/bin:$PATH"
```

## Registering a Number

Signal requires a CAPTCHA token for new registrations.

### Step 1 — Get a CAPTCHA token

Visit `https://signalcaptchas.org/registration/generate.html`, solve the puzzle, then right-click "Open Signal" → **Copy Link**. You get a URL starting with `signalcaptcha://`.

**Note:** CAPTCHA tokens expire in ~3 minutes. Complete registration immediately after solving.

### Step 2 — Register (SMS)

```bash
signal-cli -a +1XXXXXXXXXX register --captcha "signalcaptcha://..."
```

### Step 3 — Verify

Signal sends a 6-digit code via SMS. Verify it within ~10 minutes:

```bash
signal-cli -a +1XXXXXXXXXX verify 123456
```

**If verify returns 499 (DeprecatedVersionException):** Your signal-cli is too old. Install 0.14.1+ (see above).

### Voice fallback

If SMS doesn't arrive after ~60 seconds, request a voice call. Signal will call the number and speak the code:

```bash
# Must run SMS register first, then voice (same registration session)
signal-cli -a +1XXXXXXXXXX register --captcha "signalcaptcha://..." # SMS first
# Wait ~60 seconds, then if no SMS:
signal-cli -a +1XXXXXXXXXX register --voice
```

### Step 4 — Set profile name (required)

Signal requires a profile name to deliver messages reliably. Without one, outgoing messages may appear in a separate "unknown sender" thread on recipient devices.

```bash
JAVA_HOME=$(brew --prefix openjdk@25) signal-cli -a +1XXXXXXXXXX \
  updateProfile --name "Zora"
```

Replace `"Zora"` with whatever display name you want for your bot.

### Smoke test

```bash
# Should print an INFO log with no errors
JAVA_HOME=$(brew --prefix openjdk@25) signal-cli -a +1XXXXXXXXXX receive --timeout 3
```

Signal keys are stored at `~/.local/share/signal-cli/` — never committed to the repo.

## Configuring Zora

Copy the example policy file and fill in your values:

```bash
cp config/channel-policy.example.toml config/channel-policy.toml
```

`config/channel-policy.toml` is in `.gitignore` — **never commit it**.

### Minimal config

```toml
[signal]
phone_number = "+1XXXXXXXXXX"       # The number you registered
signal_cli_path = "~/.local/bin/signal-cli"
daemon_port = 9200

[[channel_policy.users]]
phone = "+1YYYYYYYYYY"              # Your personal number
name = "Owner"
channels = ["all"]
role = "trusted_admin"

[capability_sets.trusted_admin]
tools = ["read_file", "write_file", "bash", "web_search", "web_fetch"]
destructive_ops = true
action_budget = 100
```

See `config/channel-policy.example.toml` for the full reference with all options.

### Hot-reloading policy

Send `SIGHUP` to the Zora process to reload `channel-policy.toml` without restarting:

```bash
kill -HUP $(pgrep -f "zora")
```

## How It Works

When Zora boots, it checks for `config/channel-policy.toml`. If found:

1. **ChannelIdentityRegistry** loads the TOML and builds the trust map
2. **ChannelPolicyGate** (Casbin RBAC) enforces per-sender, per-channel access
3. **CapabilityResolver** maps sender → role → allowed tools + action budget
4. **SignalIntakeAdapter** starts the signal-cli daemon and listens for messages
5. **Orchestrator** routes inbound messages through the full task pipeline
6. **SignalResponseGateway** sends the response back, truncated to 3,800 chars if needed

**Unknown senders receive no response** (INVARIANT-3 — no information leakage).

## Security Notes

- Signal provides end-to-end encryption via the Signal Protocol
- Policy enforcement happens before any LLM call (INVARIANT-1)
- Tool allowlists are enforced before SDK invocation (INVARIANT-2)
- Message content is never logged — only sender phone and channel ID
- Prompt injection scanning is configurable via `[channels.prompt_injection]`
- Policy hot-reloads on SIGHUP without restarting the daemon

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `DeprecatedVersionException: 499` | signal-cli too old | Install 0.14.1+ |
| `AlreadyVerifiedException: 409` | Local state desynced | `signal-cli -a +1XXX deleteLocalAccountData`, re-register |
| `AuthorizationFailed: 403` | CAPTCHA expired | Solve a fresh CAPTCHA (they expire in ~3 min) |
| `Invalid verification method: voice` | Skipped SMS step | Do SMS register first, then voice |
| Channel not starting | Missing config | Check `config/channel-policy.toml` exists |
| `UnsupportedClassVersionError: 69.0` | Java too old | signal-cli 0.14.1 requires Java 25; set `JAVA_HOME=$(brew --prefix openjdk@25)` before starting Zora |
| Sends succeed but no message received | signal-cli version mismatch | Set `signal_cli_path = "~/.local/bin/signal-cli"` in TOML so Zora uses 0.14.1, not the bundled 0.14.0 |
| Bot messages appear in separate unknown chat | No profile name set | Run `signal-cli updateProfile --name "Zora"` (Step 4 above) |
| First messages not visible | Signal Message Requests | Check Message Requests — first contact from an unknown number goes there; accept to merge |
| Dashboard port conflict | Multiple Zora instances | Set `dashboard_port` in `~/.zora/config.toml` steering section; each instance needs a unique port |
| Unknown sender dropped | Not in policy | Add `[[channel_policy.users]]` block |

## Environment Variables

All sensitive values can be provided via environment variables instead of `channel-policy.toml`:

| Variable | Description |
|----------|-------------|
| `ZORA_SIGNAL_PHONE` | Phone number (overrides `phone_number` in TOML) |

## VoIP Numbers

VoIP numbers work with Signal registration. Tested providers:
- **Agent Phone** (`agentphone.to`) — programmatic API for receiving SMS + call transcripts
- Google Voice, MySudo, Burner, VoIP.ms

Some VoIP providers may be rate-limited by Signal if frequently used for registrations. If registration is blocked, use a different provider or wait 24 hours.
