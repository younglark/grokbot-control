/**
 * Login URL preset. Default `cli` keeps the library redirectTarget (A:38845; live 2026-11-07).
 * `bot` matches the official App login URL shape: redirectTarget=sand (A:49834) and
 * supportsSelectedTeamLogin=true (Rdn). This is a URL-shape option only — it does not
 * read App credentials, invent a team id, or send x-cursor-team-id / App client headers.
 */
export const LOGIN_MODES = ["cli", "bot"];
