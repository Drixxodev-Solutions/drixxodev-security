```markdown
# drixxodev-security Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the `drixxodev-security` repository, a TypeScript codebase built with the Next.js framework. You'll learn about file naming, import/export styles, commit message patterns, and how to structure and run tests. This guide also suggests useful commands for streamlining common workflows.

## Coding Conventions

### File Naming
- Use **camelCase** for filenames.
  - Example: `userProfile.ts`, `authService.ts`

### Import Style
- Use **alias imports** for modules.
  - Example:
    ```typescript
    import { authenticateUser } from '@/services/authService';
    ```

### Export Style
- Use **named exports** for all modules.
  - Example:
    ```typescript
    // In authService.ts
    export function authenticateUser(credentials: Credentials) { ... }
    ```

### Commit Message Patterns
- Commit messages are **freeform** but often use the `m1` prefix.
- Average commit message length: **57 characters**.
  - Example:
    ```
    m1: add user authentication middleware for API routes
    ```

## Workflows

_No automated workflows detected in this repository._

## Testing Patterns

- **Test File Pattern:** Files named as `*.test.*` (e.g., `authService.test.ts`)
- **Testing Framework:** Not explicitly detected; check project dependencies for specifics.
- **Test Example:**
  ```typescript
  // authService.test.ts
  import { authenticateUser } from '@/services/authService';

  describe('authenticateUser', () => {
    it('should return true for valid credentials', () => {
      expect(authenticateUser({ user: 'admin', pass: 'secret' })).toBe(true);
    });
  });
  ```

## Commands
| Command | Purpose |
|---------|---------|
| /test   | Run all tests in the repository (suggested) |
| /lint   | Lint the codebase (suggested) |
| /commit | Prepare a commit message following the repository pattern |
```
