import { defineMeta } from "blume";

import { OPENCODE_ICON } from "../../../harness-icons.ts";

export default defineMeta({
	title: "OpenCode v2",
	icon: OPENCODE_ICON,
	pages: ["tools", "command", "config", "files", "comparison"],
});
