// $app/server for an operator CLI: there is no request, so anything that asks for one throws, as it would
// outside a request in the server itself.
export function getRequestEvent(): never {
	throw new Error("getRequestEvent: an operator CLI runs outside any request");
}
export function read(): never {
	throw new Error("read: $app/server's asset reader is unavailable to an operator CLI");
}
