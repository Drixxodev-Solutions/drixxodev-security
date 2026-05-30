```markdown
# drixxodev-security Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill covers the core development patterns and conventions used in the `drixxodev-security` repository, a TypeScript codebase built with Next.js. You'll learn how to structure files, write imports and exports, and follow the project's commit and testing patterns. This guide also provides suggested commands for common workflows.

## Coding Conventions

### File Naming
- Use **camelCase** for file names.
  - Example: `userProfile.ts`, `authMiddleware.ts`

### Import Style
- Use **alias imports** for modules.
  - Example:
    ```typescript
    import { AuthService } from '@services/authService';
    import config from '@config/index';
    ```

### Export Style
- **Mixed** export style: both named and default exports are used.
  - Example (named export):
    ```typescript
    export function verifyToken(token: string): boolean { ... }
    ```
  - Example (default export):
    ```typescript
    const logger = { ... };
    export default logger;
    ```

### Commit Patterns
- Commit messages are **freeform** (no enforced type or scope).
- Prefixes are sometimes used but not standardized.
- Average commit message length: ~43 characters.
  - Example: `Add JWT validation middleware`

## Workflows

### Adding a New Feature
**Trigger:** When implementing new functionality.
**Command:** `/add-feature`

1. Create a new file using camelCase naming.
2. Use alias imports for dependencies.
3. Export your feature using named or default export as appropriate.
4. Write a freeform commit message describing your change.
5. Add or update corresponding test files (`*.test.*`).

### Refactoring Code
**Trigger:** When improving or restructuring existing code.
**Command:** `/refactor`

1. Identify code to refactor.
2. Rename files if needed, following camelCase convention.
3. Update imports to use aliases.
4. Adjust exports as needed (named/default).
5. Write a descriptive freeform commit message.
6. Update or add tests to cover changes.

### Writing Tests
**Trigger:** When adding or updating tests for code.
**Command:** `/write-test`

1. Create or update test files matching the `*.test.*` pattern.
2. Place test files alongside the code or in a dedicated test directory.
3. Use TypeScript for test files.
4. Ensure tests cover all critical paths.

## Testing Patterns

- Test files follow the `*.test.*` naming pattern (e.g., `authMiddleware.test.ts`).
- The testing framework is **unknown**; check existing test files for framework usage.
- Tests are written in TypeScript.
- Place test files either next to the implementation or in a `tests` directory.

## Commands
| Command        | Purpose                                 |
|----------------|-----------------------------------------|
| /add-feature   | Start the workflow for adding a feature |
| /refactor      | Begin code refactoring workflow         |
| /write-test    | Guide for writing/updating tests        |
```
