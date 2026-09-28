import { defineSchema } from "convex/server";

// No business tables yet. When adding one, see CLAUDE.md for the
// permanent rules that apply to every business table:
// - businessUnitId (hair | fashion | housing | transport) unless truly global
// - money as integer minor units + a currency field, never floats
// - deletes go through an approval request, never immediate
// - every add/update/delete writes an audit log entry
export default defineSchema({});
