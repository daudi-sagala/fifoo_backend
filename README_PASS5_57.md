# Pass 5.57 backend overlay

Apply over the Pass 5.56 backend. No SQL migration is required.

Then run:

```bash
npm run check
npm test
npm run dev
```

Adds backend workout-catalog loading for the Home Play fallback and separates reusable workout definition IDs from fresh Play session IDs.
