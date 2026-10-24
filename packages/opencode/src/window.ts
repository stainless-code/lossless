/** The model window both assembly seams read. The implementation lives in
 * the core so the hosts cannot drift; this module keeps the import path its
 * callers already use. */

export { createWindowLookup, type WindowOf } from "lossless-core";
