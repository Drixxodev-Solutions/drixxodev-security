```markdown
# drixxodev-security Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill provides a comprehensive guide to the development patterns and coding conventions used in the `drixxodev-security` repository. The codebase is built with TypeScript and Next.js, focusing on secure web application development. This guide covers file naming, import/export styles, commit message patterns, and testing practices to ensure consistency and maintainability.

## Coding Conventions

### File Naming
- Use **camelCase** for all file names.
  - Example: `userProfile.ts`, `authService.ts`

### Import Style
- Use **alias imports** for modules.
  - Example:
    ```typescript
    import { AuthService } from '@/services/authService';
    ```

### Export Style
- Use **named exports** for all modules and components.
  - Example:
    ```typescript
    // In authService.ts
    export const AuthService = { /* ... */ };
    ```

### Commit Message Patterns
- Commit messages are **freeform** but often start with the prefix `m3`.
- Average commit message length: **63 characters**.
  - Example:
    ```
    m3: Refactor authentication logic for improved security checks
    ```

## Workflows

_No automated workflows detected in this repository._

## Testing Patterns

- **Testing Framework:** Not explicitly specified.
- **Test File Pattern:** All test files follow the `*.test.*` naming convention.
  - Example: `login.test.ts`, `userProfile.test.ts`
- **Test Placement:** Test files are located alongside the modules they test or in a dedicated test directory.

  ```typescript
  // login.test.ts
  import { login } from '@/services/authService';

  describe('login', () => {
    it('should authenticate valid users', () => {
      // test implementation
    });
  });
  ```

## Commands

| Command | Purpose |
|---------|---------|
| /commit-guidelines | Show commit message conventions and examples |
| /naming-conventions | Show file, import, and export naming rules |
| /test-patterns | Show how and where to write tests |
```
