import { tryPrettyPrintJson, withJsonExtension } from "./prettyPrintJson";

describe("tryPrettyPrintJson", () => {
  describe("valid JSON objects and arrays", () => {
    it("should pretty-print a compact JSON object", () => {
      expect(tryPrettyPrintJson('{"a":1,"b":"two"}')).toBe(
        '{\n  "a": 1,\n  "b": "two"\n}',
      );
    });

    it("should pretty-print a compact JSON array", () => {
      expect(tryPrettyPrintJson("[1,2,3]")).toBe("[\n  1,\n  2,\n  3\n]");
    });

    it("should pretty-print nested structures", () => {
      const input = '{"result":[{"path":"a.txt","size":123}],"status":"ok"}';
      expect(tryPrettyPrintJson(input)).toBe(
        "{\n" +
          '  "result": [\n' +
          "    {\n" +
          '      "path": "a.txt",\n' +
          '      "size": 123\n' +
          "    }\n" +
          "  ],\n" +
          '  "status": "ok"\n' +
          "}",
      );
    });

    it("should handle an empty object", () => {
      expect(tryPrettyPrintJson("{}")).toBe("{}");
    });

    it("should handle an empty array", () => {
      expect(tryPrettyPrintJson("[]")).toBe("[]");
    });

    it("should ignore surrounding whitespace", () => {
      expect(tryPrettyPrintJson('  \n {"a":1} \n ')).toBe('{\n  "a": 1\n}');
    });

    it("should return identical formatting for already pretty JSON", () => {
      const pretty = '{\n  "a": 1\n}';
      expect(tryPrettyPrintJson(pretty)).toBe(pretty);
    });

    it("should decode unicode escapes", () => {
      expect(tryPrettyPrintJson('{"name":"\\u00e4"}')).toBe(
        '{\n  "name": "ä"\n}',
      );
    });
  });

  describe("content that must be left untouched (returns undefined)", () => {
    it("should return undefined for plain text", () => {
      expect(tryPrettyPrintJson("Hello world")).toBeUndefined();
    });

    it("should return undefined for plain text starting with {", () => {
      expect(tryPrettyPrintJson("{not json at all")).toBeUndefined();
    });

    it("should return undefined for invalid JSON with trailing content", () => {
      expect(tryPrettyPrintJson('{"a":1} trailing garbage')).toBeUndefined();
    });

    it("should return undefined for a broken array", () => {
      expect(tryPrettyPrintJson("[broken")).toBeUndefined();
    });

    it("should return undefined for numbers", () => {
      expect(tryPrettyPrintJson("123")).toBeUndefined();
      expect(tryPrettyPrintJson("-4.5e10")).toBeUndefined();
    });

    it("should return undefined for booleans and null", () => {
      expect(tryPrettyPrintJson("true")).toBeUndefined();
      expect(tryPrettyPrintJson("null")).toBeUndefined();
    });

    it("should return undefined for a JSON string primitive", () => {
      expect(tryPrettyPrintJson('"just a string"')).toBeUndefined();
    });

    it("should return undefined for an empty string", () => {
      expect(tryPrettyPrintJson("")).toBeUndefined();
    });

    it("should return undefined for whitespace only", () => {
      expect(tryPrettyPrintJson("   \n\t ")).toBeUndefined();
    });
  });
});

describe("withJsonExtension", () => {
  it("should append .json to a plain name", () => {
    expect(withJsonExtension("citt_file_read")).toBe("citt_file_read.json");
  });

  it("should append .json to names containing dots", () => {
    expect(withJsonExtension("Tool output (v2.1)")).toBe(
      "Tool output (v2.1).json",
    );
  });

  it("should not duplicate an existing .json extension", () => {
    expect(withJsonExtension("result.json")).toBe("result.json");
  });

  it("should treat the extension case-insensitively", () => {
    expect(withJsonExtension("RESULT.JSON")).toBe("RESULT.JSON");
    expect(withJsonExtension("result.Json")).toBe("result.Json");
  });

  it("should append .json to other extensions like .jsonl", () => {
    expect(withJsonExtension("file.jsonl")).toBe("file.jsonl.json");
  });

  it("should handle an empty name", () => {
    expect(withJsonExtension("")).toBe(".json");
  });
});
