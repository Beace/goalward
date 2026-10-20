# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| Latest prerelease | :white_check_mark: |
| Older versions | :x: |

Only the latest prerelease version receives security updates. Please update to the most recent version before reporting vulnerabilities.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, report security vulnerabilities by emailing:

**beaceshimin@gmail.com**

Please include the following information:

- A description of the vulnerability
- Steps to reproduce the issue
- Potential impact of the vulnerability
- Any suggested fixes (optional)

You should receive a response within 72 hours. If you do not receive a response, please follow up to ensure your report was received.

## What to Expect

After you report a vulnerability:

1. **Acknowledgment**: We will acknowledge receipt of your report within 72 hours.
2. **Assessment**: We will investigate and assess the vulnerability's severity and impact.
3. **Fix Development**: If confirmed, we will develop a fix and coordinate disclosure timing with you.
4. **Disclosure**: We will release the fix and publicly disclose the vulnerability, crediting you if desired.

## Security Considerations

### Current State

- **macOS Signing**: Builds use ad-hoc signing and are not Apple-notarized. macOS will show security warnings on first launch.
- **Agent Permissions**: Runtime permissions (read, write, tool access) are configured per-agent. Review and restrict permissions based on your security requirements.
- **Local Data**: Workspace data is stored locally in `~/Library/Application Support/dev.goalward.desktop/`. This directory is not encrypted by Goalward; rely on macOS FileVault for at-rest encryption if needed.

### Best Practices

- Keep Goalward updated to the latest version
- Review agent permissions before granting access to sensitive directories
- Use the file integrity checksums provided with releases to verify downloads
- Report any suspicious behavior through the security contact above

## Third-Party Dependencies

Goalward depends on external agent CLIs (Codex, Claude Code, Kimi CLI, Pi, DeepSeek Harness). Security issues in these external tools should be reported to their respective maintainers.

For vulnerabilities in Goalward's JavaScript or Rust dependencies, please include dependency version information in your report.
