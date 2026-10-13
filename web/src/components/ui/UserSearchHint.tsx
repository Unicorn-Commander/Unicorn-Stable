/** Quiet line under a people-search box. The search request is unchanged. */
export const USER_SEARCH_HINT =
  "Not listed? Type their full email or username.";

export function UserSearchHint() {
  return (
    <p className="-mt-2 mb-3 px-1 text-xs text-slate-500">{USER_SEARCH_HINT}</p>
  );
}
