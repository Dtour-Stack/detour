#!/usr/bin/env python3
"""
Quick validation script for skills - minimal version
"""

import re
import sys
from pathlib import Path

import yaml

MAX_SKILL_NAME_LENGTH = 64


def load_frontmatter(skill_path):
    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        return None, "SKILL.md not found"
    content = skill_md.read_text()
    if not content.startswith("---"):
        return None, "No YAML frontmatter found"
    match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
    if not match:
        return None, "Invalid frontmatter format"
    try:
        frontmatter = yaml.safe_load(match.group(1))
    except yaml.YAMLError as e:
        return None, f"Invalid YAML in frontmatter: {e}"
    if not isinstance(frontmatter, dict):
        return None, "Frontmatter must be a YAML dictionary"
    return frontmatter, None


def validate_allowed_keys(frontmatter):
    allowed_properties = {"name", "description", "license", "allowed-tools", "metadata"}
    unexpected_keys = set(frontmatter.keys()) - allowed_properties
    if not unexpected_keys:
        return True, ""
    allowed = ", ".join(sorted(allowed_properties))
    unexpected = ", ".join(sorted(unexpected_keys))
    return (
        False,
        f"Unexpected key(s) in SKILL.md frontmatter: {unexpected}. Allowed properties are: {allowed}",
    )


def validate_name(frontmatter):
    if "name" not in frontmatter:
        return False, "Missing 'name' in frontmatter"
    name = frontmatter.get("name", "")
    if not isinstance(name, str):
        return False, f"Name must be a string, got {type(name).__name__}"
    name = name.strip()
    if not name:
        return True, ""
    if not re.match(r"^[a-z0-9-]+$", name):
        return (
            False,
            f"Name '{name}' should be hyphen-case (lowercase letters, digits, and hyphens only)",
        )
    if name.startswith("-") or name.endswith("-") or "--" in name:
        return (
            False,
            f"Name '{name}' cannot start/end with hyphen or contain consecutive hyphens",
        )
    if len(name) > MAX_SKILL_NAME_LENGTH:
        return (
            False,
            f"Name is too long ({len(name)} characters). "
            f"Maximum is {MAX_SKILL_NAME_LENGTH} characters.",
        )
    return True, ""


def validate_description(frontmatter):
    if "description" not in frontmatter:
        return False, "Missing 'description' in frontmatter"
    description = frontmatter.get("description", "")
    if not isinstance(description, str):
        return False, f"Description must be a string, got {type(description).__name__}"
    description = description.strip()
    if "<" in description or ">" in description:
        return False, "Description cannot contain angle brackets (< or >)"
    if len(description) > 1024:
        return (
            False,
            f"Description is too long ({len(description)} characters). Maximum is 1024 characters.",
        )
    return True, ""


def validate_skill(skill_path):
    """Basic validation of a skill"""
    skill_path = Path(skill_path)
    frontmatter, error = load_frontmatter(skill_path)
    if error:
        return False, error
    for check in (validate_allowed_keys, validate_name, validate_description):
        valid, message = check(frontmatter)
        if not valid:
            return False, message
    return True, "Skill is valid!"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python quick_validate.py <skill_directory>")
        sys.exit(1)

    valid, message = validate_skill(sys.argv[1])
    print(message)
    sys.exit(0 if valid else 1)
