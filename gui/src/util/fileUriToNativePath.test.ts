import { fileUriToNativePath } from "./fileUriToNativePath";

describe("fileUriToNativePath", () => {
  describe("Windows drive URIs (VS Code Uri.toString() form)", () => {
    it("converts the percent-encoded drive colon and lowercased drive letter", () => {
      expect(
        fileUriToNativePath(
          "file:///c%3A/Users/Zuser/Documents/Rolf/VSC_Projekte/continue",
        ),
      ).toBe("C:\\Users\\Zuser\\Documents\\Rolf\\VSC_Projekte\\continue");
    });

    it("converts an already-decoded uppercase drive URI", () => {
      expect(fileUriToNativePath("file:///C:/Users/Zuser/project")).toBe(
        "C:\\Users\\Zuser\\project",
      );
    });

    it("uppercases the drive letter for any drive", () => {
      expect(fileUriToNativePath("file:///d%3A/work")).toBe("D:\\work");
    });

    it("decodes percent-encoded characters in path segments", () => {
      expect(fileUriToNativePath("file:///c%3A/Program%20Files/app")).toBe(
        "C:\\Program Files\\app",
      );
      expect(fileUriToNativePath("file:///c%3A/Users/M%C3%BCller")).toBe(
        "C:\\Users\\Müller",
      );
    });
  });

  describe("drive root boundaries", () => {
    it("handles a bare drive without trailing slash", () => {
      expect(fileUriToNativePath("file:///c%3A")).toBe("C:");
    });

    it("handles a drive root with trailing slash", () => {
      expect(fileUriToNativePath("file:///c%3A/")).toBe("C:\\");
    });
  });

  describe("UNC URIs (authority form)", () => {
    it("converts host/share form to a UNC path", () => {
      expect(fileUriToNativePath("file://server/share/dir")).toBe(
        "\\\\server\\share\\dir",
      );
    });
  });

  describe("POSIX file URIs", () => {
    it("keeps POSIX paths as-is", () => {
      expect(fileUriToNativePath("file:///home/user/project")).toBe(
        "/home/user/project",
      );
    });

    it("handles the MockIdeMessenger workspace form", () => {
      expect(fileUriToNativePath("file:///Users/user/workspace1")).toBe(
        "/Users/user/workspace1",
      );
    });

    it("handles the filesystem root", () => {
      expect(fileUriToNativePath("file:///")).toBe("/");
    });
  });

  describe("non-file URIs and native paths pass through unchanged", () => {
    it("passes through non-file schemes (e.g. vscode-remote)", () => {
      expect(
        fileUriToNativePath("vscode-remote://ssh-remote+host/home/user"),
      ).toBe("vscode-remote://ssh-remote+host/home/user");
    });

    it("passes through an already-native Windows path", () => {
      expect(fileUriToNativePath("C:\\Users\\already\\native")).toBe(
        "C:\\Users\\already\\native",
      );
    });

    it("passes through an already-native POSIX path", () => {
      expect(fileUriToNativePath("/already/posix")).toBe("/already/posix");
    });

    it("passes through the empty string", () => {
      expect(fileUriToNativePath("")).toBe("");
    });
  });

  describe("malformed input", () => {
    it("returns the original URI when percent-encoding is invalid", () => {
      expect(fileUriToNativePath("file:///c%3A/bad%zz")).toBe(
        "file:///c%3A/bad%zz",
      );
    });

    it("returns the original URI on a stray percent sign", () => {
      expect(fileUriToNativePath("file:///100%/coverage")).toBe(
        "file:///100%/coverage",
      );
    });
  });
});
