import type { ColType, SqlValue } from "@/lib/types";

import { AnalysisInputError } from "./analyses";

export interface JoinMapping {
  leftDatasetId: string;
  leftColumn: string;
  leftType: ColType;
  rightDatasetId: string;
  rightColumn: string;
  rightType: ColType;
  leftValues: SqlValue[];
  rightValues: SqlValue[];
}

export interface JoinValidation {
  typeMismatch: boolean;
  matchRate: number;
  warnings: string[];
}

export function validateJoinMapping(mapping: JoinMapping): JoinValidation {
  if (!mapping.leftDatasetId || !mapping.rightDatasetId || !mapping.leftColumn || !mapping.rightColumn) {
    throw new AnalysisInputError(
      "Choose two datasets and a join column on each side. What happened: the join configuration is incomplete. How to fix: select a join key column for each dataset you want to join.",
    );
  }
  const typeMismatch = mapping.leftType !== mapping.rightType;
  const right = new Set(mapping.rightValues.filter((value) => value !== null && value !== "").map(normalizeJoinValue));
  const usableLeft = mapping.leftValues.filter((value) => value !== null && value !== "");
  const matched = usableLeft.filter((value) => right.has(normalizeJoinValue(value))).length;
  const matchRate = usableLeft.length === 0 ? 0 : matched / usableLeft.length;
  const warnings: string[] = [];
  if (typeMismatch)
    warnings.push(
      `Join key types differ: ${mapping.leftType} versus ${mapping.rightType}. Cast the keys before joining.`,
    );
  if (matchRate < 0.8)
    warnings.push(
      `High unmatched rate: ${Math.round((1 - matchRate) * 100)}% of left join keys have no match in the right dataset.`,
    );
  return { typeMismatch, matchRate, warnings };
}

function normalizeJoinValue(value: SqlValue): string {
  return typeof value === "string" ? value.trim() : String(value);
}
