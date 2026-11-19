// Thunderbolt renders `<widget:NAME …>` in a message's text as live UI (their src/ai/widget-parser.ts):
// a "connect Gmail" OAuth prompt, a link preview that fetches a URL, a question whose answer goes back
// to the model. In Alpha the same text is inert, and an answer can carry it from a web page or a
// forked shared conversation. Escaping the `<` keeps it visible as text in Thunderbolt's markdown and
// out of their parser; the trip home restores it on rows Alpha wrote. Shared by the server's export and
// the browser's, which writes sealed conversations into the same file.
export const inertWidgets = (text: string) => text.replace(/<(?=widget:)/gi, "&lt;");
