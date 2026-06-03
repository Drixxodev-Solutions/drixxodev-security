```markdown
# drixxodev-security Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill introduces the core development patterns and conventions used in the `drixxodev-security` TypeScript codebase. It covers file organization, import/export styles, commit message habits, and testing approaches. By following these guidelines, contributors can maintain consistency and quality across the project.

## Coding Conventions

### File Naming
- Use **camelCase** for file names.
  - Example: `userAuth.ts`, `securityUtils.ts`

### Import Style
- Mixed import styles are used, including both named and default imports.
  - Example:
    ```typescript
    import fs from 'fs';
    import { encrypt, decrypt } from './cryptoUtils';
    ```

### Export Style
- Prefer **default exports** for modules.
  - Example:
    ```typescript
    // In securityService.ts
    const securityService = { /* ... */ };
    export default securityService;
    ```

### Commit Messages
- Freeform style, with no strict prefixing.
- Average commit message length: ~52 characters.
  - Example:  
    ```
    Add JWT token validation for login endpoint
    ```

## Workflows

### Adding a New Security Feature
**Trigger:** When implementing a new security-related functionality  
**Command:** `/add-security-feature`

1. Create a new camelCase-named TypeScript file for the feature.
2. Implement the feature using TypeScript best practices.
3. Use mixed import styles as needed.
4. Export the main functionality as the default export.
5. Write corresponding tests in a `.test.ts` file.
6. Commit changes with a clear, descriptive message.

### Running Tests
**Trigger:** When verifying code functionality  
**Command:** `/run-tests`

1. Identify test files (pattern: `*.test.*`).
2. Use the project's preferred test runner (framework unknown; check project docs or package.json).
3. Run all tests and review results.
4. Fix any failing tests before merging changes.

## Testing Patterns

- Test files follow the `*.test.*` naming convention (e.g., `auth.test.ts`).
- The testing framework is not specified; check the project documentation or `package.json` for details.
- Place tests alongside implementation files or in a dedicated `tests` directory.
- Example test file:
  ```typescript
  // auth.test.ts
  import authService from './authService';

  describe('authService', () => {
    it('should validate user credentials', () => {
      // test implementation
    });
  });
  ```

## Commands
| Command                | Purpose                                           |
|------------------------|---------------------------------------------------|
| /add-security-feature  | Scaffold and implement a new security feature     |
| /run-tests             | Run all test files in the project                 |
```
