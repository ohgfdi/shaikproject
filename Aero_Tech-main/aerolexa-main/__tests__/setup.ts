/* eslint-disable @typescript-eslint/no-require-imports */
// Extend expect with DOM matchers. Jest-dom detects the environment and only
// activates DOM matchers where a DOM exists (jsdom test files), leaving the
// plain node unit suites untouched.
import "@testing-library/jest-dom";
