# Phase 8 onboarding UI compatibility

The current iOS onboarding uses the account email as the username and no longer asks for a separate player tag. `signup()` accepts the validated email when the submitted username equals that email, while preserving the existing handle validator for older/alternate signup clients.

This package also retains the PostgreSQL-safe migration 009 view-column ordering fix required for production startup before migration 011 can apply.
