# Contributing to Goalward

Thank you for your interest in contributing to Goalward! This guide covers the development setup, testing workflow, and pull request process.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold a welcoming, inclusive community.

## Development Setup

### Prerequisites

- macOS 13.3 or later (Apple Silicon or Intel)
- Node.js `^20.19.0`, `^22.12.0`, or `>=24.0.0`
- npm (included with Node.js)
- Rust stable toolchain
- Cargo
- Xcode Command Line Tools

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Beace/goalward.git
   cd goalward
   ```

2. Install JavaScript dependencies:
   ```bash
   npm ci --registry=https://registry.npmjs.org
   ```

3. Start the development server:
   ```bash
   npm run mac:dev
   ```

### Build Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the Vite development server (frontend only) |
| `npm run mac:dev` | Start the Tauri development app with hot reload |
| `npm run mac:build` | Build the macOS app bundle |
| `npm run build` | Run TypeScript compiler and Vite build |
| `npm test` | Run frontend unit tests |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Run Rust unit tests |

## Running Tests

Before submitting a pull request, ensure all tests pass:

```bash
# Frontend unit tests
npm test

# TypeScript type checking
npm run build

# Rust unit tests
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

The CI pipeline runs these checks automatically on every pull request.

## Branch and Pull Request Workflow

This project follows a strict branch-based workflow as defined in [AGENTS.md](AGENTS.md).

### Creating a Branch

1. Start from the latest `main`:
   ```bash
   git fetch origin main
   git checkout -b your-branch-name origin/main
   ```

2. Use descriptive branch names. Codex agents use `codex/<task-name>`.

### Making Changes

1. Make your changes with clear, atomic commits.
2. Follow the working language policy: all code comments, test descriptions, commit messages, and PR descriptions must be in English.
3. Ensure your changes pass all tests before pushing.

### Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/) syntax:

- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation changes
- `chore:` for maintenance tasks
- `refactor:` for code refactoring
- `test:` for adding or updating tests

The PR title becomes the squash commit title on `main`, so make it descriptive.

Examples:
```
feat: add support for custom CLI runtimes
fix: resolve race condition in agent session cleanup
docs: update installation guide for macOS Sonoma
```

### Opening a Pull Request

1. Push your branch to the repository:
   ```bash
   git push -u origin your-branch-name
   ```

2. Open a pull request targeting `main`.

3. Fill out the [PR template](.github/pull_request_template.md):
   - **Summary**: Describe the problem and solution
   - **Validation**: List the checks you performed and their results
   - **Language check**: Confirm English is used for developer-facing content

4. Wait for CI checks to pass. The CI runs:
   - Frontend unit tests (`npm test`)
   - Rust unit tests (`cargo test --lib`)
   - Release tooling tests

### Review and Merge

- All PRs require review before merging.
- GitHub enforces squash merges to `main`.
- Merging does not publish immediately; releases are triggered separately.

## Working Language Policy

All developer-facing content must be in English:

- Pull request titles and descriptions
- Code comments and docstrings
- Unit test suite and case descriptions
- Development process documents

Product internationalization (i18n) text and user-facing content may use other languages as appropriate.

## UI Development

Goalward uses [shadcn/ui](https://ui.shadcn.com/) as its component foundation. When adding or modifying UI:

1. Prefer existing shadcn/ui components from `src/components/ui/`
2. Follow the design system in `.superdesign/design-system.md`
3. Support both dark and light themes
4. Respect reduced motion and accessibility preferences

## Questions?

If you have questions about contributing, feel free to:

- Open a [GitHub Discussion](https://github.com/Beace/goalward/discussions) (if enabled)
- Check existing issues and pull requests for context
- Review the [README](README.md) and [development documentation](docs/)

Thank you for contributing to Goalward!
