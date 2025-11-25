# add-in

A Node.js CLI tool that replicates the functionality of the `x mix` dotnet tool from ServiceStack. It allows you to apply gist files to your project, supporting features like MyApp replacements, JSON patching, and more.

## Installation

You can run directly with npx (no installation required):

```bash
npx add-in
```

Or install globally:

```bash
npm install -g @anthropic-custom/add-in
```

## Usage

### View all published gists

```bash
npx add-in
```

### Apply gists to your project

```bash
npx add-in <name> <name> ...
```

### Mix using numbered list index

```bash
npx add-in 1 3 5 ...
```

### Mix file contents from gist URL

```bash
npx add-in <gist-url>
```

### Delete previously mixed gists

```bash
npx add-in -delete <name> <name> ...
```

### Use custom project name

Instead of using the current folder name, you can specify a custom project name (replaces `MyApp`):

```bash
npx add-in -name ProjectName <name> <name> ...
```

### Replace additional tokens

Replace custom tokens before mixing:

```bash
npx add-in -replace term=with <name> <name> ...
```

Multiple replacements:

```bash
npx add-in -replace term=with -replace "This Phrase"="With This" <name> <name> ...
```

### Search by tag

Display available gists with a specific tag:

```bash
npx add-in [tag]
npx add-in [tag1,tag2]
```

## Options

| Option | Description |
|--------|-------------|
| `--help`, `-help`, `?` | Show help |
| `-v`, `--verbose` | Enable verbose output |
| `-s`, `--source` | Specify custom gist registry source |
| `-f`, `--force`, `-y`, `--yes` | Skip confirmation prompts |
| `-p`, `--preserve` | Don't overwrite existing files |
| `--ignore-ssl-errors` | Ignore SSL certificate errors |
| `--delete` | Delete mode - remove previously mixed files |
| `--out` | Specify output directory |
| `--name` | Specify custom project name |
| `--replace` | Replace tokens in files |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `MIX_SOURCE` | Custom gist registry ID |
| `GITHUB_TOKEN` | GitHub API token for authentication |
| `SERVICESTACK_TELEMETRY_OPTOUT` | Set to `1` or `true` to disable telemetry |

## Features

- **MyApp Replacement**: Automatically replaces `MyApp`, `My_App`, `my-app`, `myapp`, `My App`, `my_app` with your project name
- **JSON Patching**: Support for `.json.patch` files using JSON Patch format
- **Base64 Files**: Support for binary files encoded as base64
- **Init Scripts**: Execute initialization commands (`npm`, `dotnet`, `flutter`, etc.) from `_init` files
- **Tag Search**: Filter gists by tags
- **Delete Mode**: Remove previously mixed files

## License

BSD-3-Clause
