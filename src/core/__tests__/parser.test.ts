import { SolidityParser } from '../parser';
import * as fs from 'fs';

describe('SolidityParser', () => {
  let parser: SolidityParser;

  beforeEach(() => {
    parser = new SolidityParser();
  });

  describe('parseFile', () => {
    it('should parse a simple ERC20 contract', () => {
      const mockContent = `
        contract SimpleToken {
          function transfer(address to, uint256 amount) public returns (bool) {
            return true;
          }
          
          function balanceOf(address account) public view returns (uint256) {
            return 0;
          }
          
          event Transfer(address indexed from, address indexed to, uint256 value);
        }
      `;

      jest.spyOn(fs, 'readFileSync').mockReturnValue(mockContent);
      jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() } as any);

      const result = parser.parseFile('/test/SimpleToken.sol');

      expect(result).not.toBeNull();
      expect(result?.name).toBe('SimpleToken');
      expect(result?.functions).toHaveLength(2);
      expect(result?.events).toHaveLength(1);
    });

    it('should extract function with correct visibility', () => {
      const mockContent = `
        contract TestContract {
          function publicFunc() public {}
          function externalFunc() external {}
          function internalFunc() internal {}
          function privateFunc() private {}
        }
      `;

      jest.spyOn(fs, 'readFileSync').mockReturnValue(mockContent);
      jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() } as any);

      const result = parser.parseFile('/test/TestContract.sol');

      expect(result?.functions).toHaveLength(4);
      expect(result?.functions.find((f) => f.name === 'publicFunc')?.visibility).toBe('public');
      expect(result?.functions.find((f) => f.name === 'externalFunc')?.visibility).toBe('external');
      expect(result?.functions.find((f) => f.name === 'internalFunc')?.visibility).toBe('internal');
      expect(result?.functions.find((f) => f.name === 'privateFunc')?.visibility).toBe('private');
    });

    it('should extract functions with state mutability', () => {
      const mockContent = `
        contract TestContract {
          function viewFunc() public view returns (uint256) { return 0; }
          function pureFunc() public pure returns (uint256) { return 1; }
          function payableFunc() public payable {}
          function normalFunc() public {}
        }
      `;

      jest.spyOn(fs, 'readFileSync').mockReturnValue(mockContent);
      jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() } as any);

      const result = parser.parseFile('/test/TestContract.sol');

      expect(result?.functions.find((f) => f.name === 'viewFunc')?.stateMutability).toBe('view');
      expect(result?.functions.find((f) => f.name === 'pureFunc')?.stateMutability).toBe('pure');
      expect(result?.functions.find((f) => f.name === 'payableFunc')?.stateMutability).toBe(
        'payable'
      );
      expect(result?.functions.find((f) => f.name === 'normalFunc')?.stateMutability).toBe(
        'nonpayable'
      );
    });

    it('should extract events correctly', () => {
      const mockContent = `
        contract TestContract {
          event Transfer(address indexed from, address indexed to, uint256 value);
          event Approval(address indexed owner, address indexed spender, uint256 value);
        }
      `;

      jest.spyOn(fs, 'readFileSync').mockReturnValue(mockContent);
      jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() } as any);

      const result = parser.parseFile('/test/TestContract.sol');

      expect(result?.events).toHaveLength(2);
      expect(result?.events[0].name).toBe('Transfer');
      expect(result?.events[1].name).toBe('Approval');
    });

    it('should extract custom errors', () => {
      const mockContent = `
        contract TestContract {
          error InsufficientBalance(uint256 available, uint256 required);
          error Unauthorized();
        }
      `;

      jest.spyOn(fs, 'readFileSync').mockReturnValue(mockContent);
      jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() } as any);

      const result = parser.parseFile('/test/TestContract.sol');

      expect(result?.errors).toHaveLength(2);
      expect(result?.errors[0].name).toBe('InsufficientBalance');
      expect(result?.errors[1].name).toBe('Unauthorized');
    });

    it('should handle constructor', () => {
      const mockContent = `
        contract TestContract {
          constructor(address owner, uint256 initialSupply) public {
          }
        }
      `;

      jest.spyOn(fs, 'readFileSync').mockReturnValue(mockContent);
      jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() } as any);

      const result = parser.parseFile('/test/TestContract.sol');

      const constructor = result?.functions.find((f) => f.name === 'constructor');
      expect(constructor).toBeDefined();
      expect(constructor?.inputs).toHaveLength(2);
    });

    it('should return null for invalid files', () => {
      jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
        throw new Error('File not found');
      });

      const result = parser.parseFile('/test/Invalid.sol');
      expect(result).toBeNull();
    });

    it('should detect library contracts', () => {
      const mockContent = `
        library MathUtils {
          function add(uint256 a, uint256 b) internal pure returns (uint256) {
            return a + b;
          }
        }
      `;

      jest.spyOn(fs, 'readFileSync').mockReturnValue(mockContent);
      jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() } as any);

      const result = parser.parseFile('/test/MathUtils.sol');

      expect(result?.name).toBe('MathUtils');
    });

    it('should detect interface contracts', () => {
      const mockContent = `
        interface IERC20 {
          function transfer(address to, uint256 amount) external returns (bool);
        }
      `;

      jest.spyOn(fs, 'readFileSync').mockReturnValue(mockContent);
      jest.spyOn(fs, 'statSync').mockReturnValue({ mtime: new Date() } as any);

      const result = parser.parseFile('/test/IERC20.sol');

      expect(result?.name).toBe('IERC20');
    });
  });
});
