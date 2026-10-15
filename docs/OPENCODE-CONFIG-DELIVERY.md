# OpenCode configuration delivery diagnostics

`codemie doctor` can observe pre-existing OpenCode server processes on Linux for a
profile with a base URL. This check reads command lines and configuration-related
environment variable names through `/proc`; it does not expose their values.

The result is informational, not proof that the active profile was delivered:

- A shared service does not shadow an isolated OpenCode v2 `--standalone` launch.
- Environment markers may be empty, inherited or associated with another profile.
- No detected server does not prove that the next invocation will load its config.
- Unreadable process environments are reported as unknown. A failed process scan
  is a check failure, not a successful empty scan.
- On other platforms, server detection is explicitly reported as unsupported.

For an isolated OpenCode v2 TUI, use `codemie-opencode --standalone`. The V2 parity
update also isolates supported managed commands automatically unless an explicit
server selection is provided. `--standalone` is a v2 option, not a v1 requirement.

If you explicitly select a shared or remote server, verify that server's actual
configuration. Do not stop unrelated sessions or use a broad process-kill command
to change a profile. This diagnostic check neither starts nor stops servers and
does not depend on the separate agent-version-policy update.
