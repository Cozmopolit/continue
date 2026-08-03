import { ToolPolicy } from "@continuedev/terminal-security";
import { Tool } from "core";
import { describe, expect, it } from "vitest";
import uiReducer, {
  addTool,
  DEFAULT_TOOL_SETTING,
  DEFAULT_UI_SLICE,
  setToolPolicy,
} from "./uiSlice";

// Mock tool for testing
const createMockTool = (name: string, defaultPolicy?: ToolPolicy): Tool => ({
  type: "function" as const,
  function: {
    name,
    description: `Mock tool ${name}`,
    parameters: {},
  },
  displayTitle: name,
  wouldLikeTo: `use ${name}`,
  readonly: false,
  group: "test",
  defaultToolPolicy: defaultPolicy,
});

describe("uiSlice", () => {
  describe("addTool", () => {
    it("should add a new tool with default policy when no policy exists", () => {
      const tool = createMockTool("TestTool");
      const state = uiReducer(DEFAULT_UI_SLICE, addTool(tool));

      expect(state.toolSettings["TestTool"]).toBe(DEFAULT_TOOL_SETTING);
    });

    it("should add a new tool with its specified defaultToolPolicy", () => {
      const tool = createMockTool("TestTool", "allowedWithoutPermission");
      const state = uiReducer(DEFAULT_UI_SLICE, addTool(tool));

      expect(state.toolSettings["TestTool"]).toBe("allowedWithoutPermission");
    });

    it("should NOT overwrite existing user-configured policy", () => {
      // User has configured MultiEdit to be disabled
      const initialState = {
        ...DEFAULT_UI_SLICE,
        toolSettings: {
          MultiEdit: "disabled" as ToolPolicy,
        },
      };

      // Tool is registered again (e.g., after config reload)
      const tool = createMockTool("MultiEdit", "allowedWithPermission");
      const state = uiReducer(initialState, addTool(tool));

      // User's "disabled" setting should be preserved, not overwritten
      expect(state.toolSettings["MultiEdit"]).toBe("disabled");
    });

    it("should NOT overwrite existing policy even if tool has different default", () => {
      // User has set tool to auto-approve
      const initialState = {
        ...DEFAULT_UI_SLICE,
        toolSettings: {
          SomeTool: "allowedWithoutPermission" as ToolPolicy,
        },
      };

      // Tool is re-registered with a different default
      const tool = createMockTool("SomeTool", "disabled");
      const state = uiReducer(initialState, addTool(tool));

      // User's setting should be preserved
      expect(state.toolSettings["SomeTool"]).toBe("allowedWithoutPermission");
    });

    it("should allow adding new tools alongside existing ones", () => {
      const initialState = {
        ...DEFAULT_UI_SLICE,
        toolSettings: {
          ExistingTool: "disabled" as ToolPolicy,
        },
      };

      const newTool = createMockTool("NewTool", "allowedWithPermission");
      const state = uiReducer(initialState, addTool(newTool));

      // Existing tool should be preserved
      expect(state.toolSettings["ExistingTool"]).toBe("disabled");
      // New tool should be added
      expect(state.toolSettings["NewTool"]).toBe("allowedWithPermission");
    });
  });

  describe("setToolPolicy", () => {
    it("should allow explicitly setting a tool policy", () => {
      const initialState = {
        ...DEFAULT_UI_SLICE,
        toolSettings: {
          TestTool: "allowedWithPermission" as ToolPolicy,
        },
      };

      const state = uiReducer(
        initialState,
        setToolPolicy({ toolName: "TestTool", policy: "disabled" }),
      );

      expect(state.toolSettings["TestTool"]).toBe("disabled");
    });

    it("should add a new tool policy via setToolPolicy", () => {
      const state = uiReducer(
        DEFAULT_UI_SLICE,
        setToolPolicy({ toolName: "NewTool", policy: "disabled" }),
      );

      expect(state.toolSettings["NewTool"]).toBe("disabled");
    });
  });
});
