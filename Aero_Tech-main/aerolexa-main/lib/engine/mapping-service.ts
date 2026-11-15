/**
 * Advanced field mapping service for CA-specific data reconciliation
 */

/** A parsed row whose columns are not known until runtime. */
export type MappingRow = Record<string, unknown>;

export interface FieldMapping {
  sourceField: string;
  targetField: string;
  transform?: (value: unknown) => unknown;
  validation?: (value: unknown) => boolean;
}

export interface MappingRule {
  id: string;
  name: string;
  sourceType: string;
  targetType: string;
  mappings: FieldMapping[];
  confidence: number;
}

export class MappingService {
  /**
   * Auto-suggest mappings between source and target field names
   */
  static suggestMappings(sourceFields: string[], targetFields: string[]): FieldMapping[] {
    const mappings: FieldMapping[] = [];
    const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

    for (const target of targetFields) {
      const targetNorm = normalized(target);
      for (const source of sourceFields) {
        const sourceNorm = normalized(source);
        if (sourceNorm === targetNorm || sourceNorm.includes(targetNorm) || targetNorm.includes(sourceNorm)) {
          mappings.push({
            sourceField: source,
            targetField: target,
          });
        }
      }
    }
    return mappings;
  }

  /**
   * Apply mappings to transform source data
   */
  static transform(data: MappingRow[], mappings: FieldMapping[]): MappingRow[] {
    return data.map((row) => {
      const result: MappingRow = {};
      for (const mapping of mappings) {
        if (mapping.sourceField in row) {
          const value = row[mapping.sourceField];
          if (value !== undefined && mapping.transform) {
            result[mapping.targetField] = mapping.transform(value);
          } else if (value !== undefined) {
            result[mapping.targetField] = value;
          }
        }
      }
      return result;
    });
  }

  /**
   * Validate mapped data
   */
  static validate(data: MappingRow[], mappings: FieldMapping[]): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      if (!row) continue;
      for (const mapping of mappings) {
        if (mapping.validation && mapping.sourceField in row) {
          const value = row[mapping.sourceField];
          if (value !== undefined && !mapping.validation(value)) {
            errors.push(`Row ${i + 1}: Invalid value for ${mapping.sourceField}`);
          }
        }
      }
    }
    return { valid: errors.length === 0, errors };
  }
}
