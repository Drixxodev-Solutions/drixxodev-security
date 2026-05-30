```markdown
# drixxodev-security Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill provides a comprehensive guide to the development patterns and conventions used in the `drixxodev-security` repository. The project is built with TypeScript using the Next.js framework, and it follows specific conventions for file naming, imports, exports, commit messages, and testing. This guide will help you quickly onboard and contribute effectively to the codebase.

## Coding Conventions

### File Naming
- Use **camelCase** for file names.
  - Example: `userProfile.ts`, `authService.ts`

### Import Style
- Use **alias imports** for referencing modules.
  - Example:
    ```typescript
    import { AuthService } from '@/services/authService';
    ```

### Export Style
- Both **named** and **default exports** are used.
  - Named export example:
    ```typescript
    export function validateToken(token: string): boolean { ... }
    ```
  - Default export example:
    ```typescript
    export default AuthService;
    ```

### Commit Message Patterns
- Mixed types, often prefixed with `ci` for continuous integration changes.
- Average commit message length: ~53 characters.
  - Example: `ci: update deployment workflow for staging`

## Workflows

_No automated workflows detected in the repository._

## Testing Patterns

- **Test File Naming:** Test files use the `*.test.*` pattern.
  - Example: `authService.test.ts`
- **Testing Framework:** Not explicitly detected. Check the repository for more details or use common frameworks like Jest for Next.js projects.
- **Test Example:**
  ```typescript
  // authService.test.ts
  import { validateToken } from '@/services/authService';

  describe('validateToken', () => {
    it('should return true for valid tokens', () => {
      expect(validateToken('valid-token')).toBe(true);
    });
  });
  ```

## Commands
| Command | Purpose |
|---------|---------|
| /test   | Run all test suites (suggested) |
| /lint   | Run the linter to check code style (suggested) |
| /build  | Build the Next.js project (suggested) |
| /dev    | Start the Next.js development server (suggested) |
```
