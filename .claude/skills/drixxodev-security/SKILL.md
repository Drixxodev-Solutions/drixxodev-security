```markdown
# drixxodev-security Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill covers the development conventions and workflows used in the `drixxodev-security` repository, a TypeScript codebase built with Next.js. You'll learn how to structure files, write imports and exports, and follow the project's testing patterns. This guide also provides command suggestions for common development tasks.

## Coding Conventions

### File Naming
- Use **camelCase** for all file names.
  - Example: `userAuth.ts`, `apiRoutes.ts`

### Import Style
- Use **alias-based imports** rather than relative paths.
  - Example:
    ```typescript
    import { authenticate } from '@lib/auth'
    import config from '@config/index'
    ```

### Export Style
- Both named and default exports are used.
  - Named export example:
    ```typescript
    export function verifyToken(token: string) { ... }
    ```
  - Default export example:
    ```typescript
    export default AuthProvider
    ```

### Commit Patterns
- Commits are freeform, sometimes prefixed with `m4`.
- Average commit message length: ~50 characters.
  - Example: `m4 add JWT validation to login endpoint`

## Workflows

### Add a New Feature
**Trigger:** When implementing a new feature or endpoint  
**Command:** `/add-feature`

1. Create a new file using camelCase naming.
2. Use alias imports for shared modules.
3. Export your feature using named or default exports as appropriate.
4. Write corresponding tests in a `.test.ts` file.
5. Commit with a descriptive message, optionally prefixed with `m4`.

### Update Dependencies
**Trigger:** When updating or adding dependencies  
**Command:** `/update-deps`

1. Install the new or updated package.
2. Update import statements to use aliases if needed.
3. Run tests to ensure compatibility.
4. Commit changes with a clear message.

### Run Tests
**Trigger:** Before pushing changes or merging  
**Command:** `/run-tests`

1. Run all tests using Vitest:
    ```bash
    npx vitest run
    ```
2. Ensure all tests pass.
3. Address any failures before committing.

## Testing Patterns

- **Framework:** Vitest
- **Test File Pattern:** `*.test.ts`
- Place test files alongside the modules they test or in a dedicated test directory.
- Example test file:
    ```typescript
    import { verifyToken } from '@lib/auth'

    describe('verifyToken', () => {
      it('returns true for valid token', () => {
        expect(verifyToken('valid.jwt.token')).toBe(true)
      })
    })
    ```

## Commands

| Command        | Purpose                                   |
|----------------|-------------------------------------------|
| /add-feature   | Scaffold and document a new feature       |
| /update-deps   | Update or add dependencies                |
| /run-tests     | Run the full test suite with Vitest       |
```
