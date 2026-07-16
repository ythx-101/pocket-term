# Windows Support

## Current status

pocket-term is tested on **Linux** and **macOS**. Windows is supported via WSL.
Native Windows support (without WSL) is not tested and not documented.

## WSL (recommended)

Install [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install) with
a Linux distribution (Ubuntu recommended), then follow the standard Linux
instructions:

```bash
# Inside WSL
git clone https://github.com/ythx-101/pocket-term.git
cd pocket-term
./scripts/install-l1.sh
```

All L0, L1, and L2 features work inside WSL. The terminal is accessible from
your Windows browser at `http://127.0.0.1:7681` (WSL2 uses localhost forwarding).

### WSL-specific notes

- **Tailscale**: Install Tailscale inside WSL, not on the Windows host.
  Use `tailscale serve` for zero-public-exposure access (recommended).
- **systemd**: WSL2 with systemd enabled (default since WSL 0.67.6) supports
  `systemctl --user` for service management.
- **Firewall**: Windows Firewall does not block localhost traffic to WSL.

## Native Windows (future)

Native Windows support is tracked as a future enhancement. Challenges:

- ttyd 1.6.3 does not ship Windows binaries.
- systemd and launchd templates don't apply — would need Windows Service or Task Scheduler.
- File path handling differs (`C:\` vs `/`).

If you need this, please open a GitHub issue with your use case. Contributions welcome.
