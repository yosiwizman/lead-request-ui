# AI Rules for lead-request-ui

This document defines the app’s core tech stack and clear rules for choosing libraries.

Tech stack overview (5–10 bullets):
- React 18 with Vite for fast development and production builds.
- TypeScript for type safety across components, services, and tests.
- Styling with plain CSS (src/index.css and src/App.css); no CSS framework by default.
- ESLint (TypeScript + React plugins) for consistent code quality.
- Vitest for unit and smoke tests.
- Vercel for deployment (as noted in README).
- Supabase as the preferred backend for data and auth when needed.
- Environment configuration via Vite env vars (VITE_*), loaded at build time.

Library usage rules:
- UI and styling: Start with native HTML + CSS. Only add a UI library if the complexity justifies it; if a utility CSS framework becomes necessary, prefer Tailwind CSS. Keep components small and focused.
- Icons: Prefer inline SVG or small assets. If a library is needed, use lucide-react. Add only when icons are used in multiple places.
- Forms and validation: Use controlled inputs and HTML validation first. For complex validation schemas, prefer Zod; keep validation logic close to form components or a small helper.
- Routing: The app is currently single-page. If multiple views are needed, use React Router and keep routes in src/App.tsx.
- Data and APIs: Use the browser fetch API and encapsulate calls in src/services/*.ts modules (e.g., leadService). When persistence or auth is required, use Supabase as the backend.
- State management: Use React hooks (useState/useReducer) for local state; use Context API for shared state. Avoid heavy state libraries unless absolutely necessary.
- Testing: Use Vitest for unit tests. If DOM interaction tests are required, add @testing-library/react to test user-facing behavior.
- Dates and formatting: Prefer native Date and Intl APIs. If needed, use date-fns for lightweight utilities.
- CSV/exports: Implement using Blob/URL and minimal helpers (as in leadService). Avoid large CSV libraries unless requirements expand.
- Linting and formatting: Follow the existing ESLint config. Keep types explicit, avoid any, and prefer narrow interfaces and types.