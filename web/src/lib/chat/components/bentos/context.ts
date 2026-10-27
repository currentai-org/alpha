/**
 * Context key a host sets to a getter for whether the reader is signed in
 * (`setContext(BENTO_SIGNED_IN, () => Boolean(page.data.user))`), so a bento states the retention
 * rule that applies to them: guest chats expire, a signed-in account's stay until deleted. Absent,
 * a bento speaks to a guest (the /alpha landing page).
 */
export const BENTO_SIGNED_IN = 'bento:signed-in';
