# Security Policy

## Supported Versions

We release patches for security vulnerabilities. Which versions are eligible for receiving such patches depends on the CVSS v3.0 Rating:

| Version | Supported          |
| ------- | ------------------ |
| 0.3.x   | :white_check_mark: |
| 0.2.x   | :white_check_mark: |
| < 0.2   | :x:                |
 
## Reporting a Vulnerability

If you discover a security vulnerability within SigScan, please send an email to the maintainers. All security vulnerabilities will be promptly addressed.

**Please do not report security vulnerabilities through public GitHub issues.**

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

- **Initial Response**: Within 48 hours
- **Status Update**: Within 7 days
- **Fix Timeline**: Depends on severity
  - Critical: Within 7 days
  - High: Within 14 days
  - Medium: Within 30 days
  - Low: Next release cycle

## Security Best Practices

When using SigScan:

1. Always review generated signatures before committing
2. Keep the extension updated to the latest version
3. Use .gitignore to exclude sensitive data
4. Verify signatures match expected values for critical contracts

## Known Security Considerations

- SigScan reads Solidity files from your workspace
- Generated signatures are stored in plain text
- No external network calls are made during scanning

## Acknowledgments

We appreciate security researchers who responsibly disclose vulnerabilities.
