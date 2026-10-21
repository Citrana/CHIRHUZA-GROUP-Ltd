import { expect, test } from "vitest";
import { splitOverLots } from "./sales";

test("splitOverLots: oldest lot first, across lots, never more than on hand", () => {
  const lots = [{ id: "old", onHand: 1 }, { id: "empty", onHand: 0 }, { id: "new", onHand: 50 }];
  expect(splitOverLots(lots, 1)?.map((p) => [p.lot.id, p.qty])).toEqual([["old", 1]]);
  expect(splitOverLots(lots, 3)?.map((p) => [p.lot.id, p.qty])).toEqual([
    ["old", 1],
    ["new", 2],
  ]);
  expect(splitOverLots(lots, 51)?.map((p) => [p.lot.id, p.qty])).toEqual([
    ["old", 1],
    ["new", 50],
  ]);
  expect(splitOverLots(lots, 52)).toBeNull();
  expect(splitOverLots([], 1)).toBeNull();
});
