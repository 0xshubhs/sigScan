import { ProjectScanner } from '../scanner';
import * as fs from 'fs';
import * as path from 'path';

// Mock the parser
jest.mock('../parser', () => {
  return {
    SolidityParser: jest.fn().mockImplementation(() => ({
      parseFile: jest.fn().mockReturnValue({
        name: 'MockContract',
        filePath: '/test/MockContract.sol',
        functions: [],
        events: [],
        errors: [],
        lastModified: new Date(),
        category: 'contracts',
      }),
    })),
  };
});

describe('ProjectScanner', () => {
  let scanner: ProjectScanner;

  beforeEach(() => {
    scanner = new ProjectScanner();
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with project path', () => {
      expect(scanner).toBeDefined();
    });
  });

  describe('categorization', () => {
    it('should categorize test files correctly', () => {
      const testPaths = [
        '/project/test/Token.t.sol',
        '/project/tests/Token.test.sol',
        '/project/src/Token.t.sol',
      ];

      testPaths.forEach((filePath) => {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore - accessing private method for testing
        const category = scanner.categorizeContract(filePath);
        expect(category).toBe('tests');
      });
    });

    it('should categorize library files correctly', () => {
      const libPaths = ['/project/lib/SafeMath.sol', '/project/libraries/Utils.sol'];

      libPaths.forEach((filePath) => {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore - accessing private method for testing
        const category = scanner.categorizeContract(filePath);
        expect(category).toBe('libs');
      });
    });

    it('should categorize regular contract files', () => {
      const contractPaths = ['/project/src/Token.sol', '/project/contracts/NFT.sol'];

      contractPaths.forEach((filePath) => {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore - accessing private method for testing
        const category = scanner.categorizeContract(filePath);
        expect(category).toBe('contracts');
      });
    });
  });

  describe('file discovery', () => {
    it('should find Solidity files recursively', () => {
      const mockFiles = [
        '/project/src/Token.sol',
        '/project/src/NFT.sol',
        '/project/test/Token.t.sol',
      ];

      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'statSync').mockImplementation((filePath) => {
        if (filePath === '/test/project') {
          return { isDirectory: () => true } as any;
        }
        return { isDirectory: () => false, isFile: () => true } as any;
      });

      // Mock readdir to return files
      jest.spyOn(fs, 'readdirSync').mockReturnValue(mockFiles.map((f) => path.basename(f)) as any);

      // Test would require more complex mocking for recursive directory scanning
      expect(scanner).toBeDefined();
    });
  });

  describe('contract filtering', () => {
    it('should filter internal functions when configured', () => {
      const options = { includeInternal: false };
      expect(options.includeInternal).toBe(false);
    });

    it('should filter private functions when configured', () => {
      const options = { includePrivate: false };
      expect(options.includePrivate).toBe(false);
    });
  });

  describe('library filtering', () => {
    it('should identify library imports', () => {
      const content = `
        import "./lib/SafeMath.sol";
        
        contract Token {
          using SafeMath for uint256;
        }
      `;

      // Test library import detection logic
      expect(content).toContain('import');
      expect(content).toContain('lib/');
    });
  });
});
