# GitHub Actions Workflows

This directory contains GitHub Actions workflows for the add-in project.

## Workflows

### CI (`ci.yml`)

Runs on every push to `main` and on all pull requests.

**What it does:**
- Tests the package on multiple Node.js versions (14, 16, 18, 20)
- Runs the test suite (`npm test`)
- Verifies the CLI script is executable

### Publish to npm (`publish.yml`)

Runs automatically when a new GitHub release is created.

**What it does:**
- Installs dependencies
- Runs tests to ensure quality
- Publishes the package to npm with provenance using OIDC authentication

**Features:**
- Uses OpenID Connect (OIDC) for secure authentication
- Publishes with `--provenance` flag for supply chain security
- Automatically makes the package public with `--access public`

## Publishing to npm

To publish a new version:

1. Update the version in `package.json`:
   ```bash
   npm version patch  # for bug fixes
   npm version minor  # for new features
   npm version major  # for breaking changes
   ```

2. Push the changes and tags:
   ```bash
   git push && git push --tags
   ```

3. Create a GitHub release:
   - Go to https://github.com/ServiceStack/add-in/releases/new
   - Select the version tag you just pushed
   - Add release notes describing the changes
   - Click "Publish release"

4. The `publish.yml` workflow will automatically:
   - Run tests
   - Publish to npm if tests pass

## Required Setup

### NPM Authentication

The workflow uses OIDC (OpenID Connect) authentication with provenance for enhanced security. You still need to configure an `NPM_TOKEN` secret:

1. Generate an npm Automation token:
   - Log in to https://www.npmjs.com
   - Go to Account Settings → Access Tokens
   - Click "Generate New Token" → Choose "Automation"
   - Copy the generated token

2. Add the token to GitHub:
   - Go to repository Settings → Secrets and variables → Actions
   - Click "New repository secret"
   - Name: `NPM_TOKEN`
   - Value: Your npm automation token
   - Click "Add secret"

### OIDC Permissions

The workflow includes the required permissions:
```yaml
permissions:
  id-token: write  # Required for OIDC authentication
  contents: read
```

These permissions allow the workflow to:
- Authenticate with npm using OIDC
- Generate provenance attestations for supply chain security
- Read repository contents for publishing

## Manual Publishing

If you prefer to publish manually:

```bash
npm login
npm publish --access public
```

To publish with provenance locally (requires npm 9.5.0+):

```bash
npm publish --provenance --access public
```

**Note:** Provenance generation may not work from all environments. GitHub Actions is the recommended way to publish with provenance.
