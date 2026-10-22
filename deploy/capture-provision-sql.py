"""Capture the SQL the real provisioning routine emits, without a database.

The deployment grants the runtime role in `deploy/provision-runtime.py`, and
that script is a second renderer of the reviewed policy. A gate that compares
the two needs the statements the script really emits, so this helper calls the
actual `main()` routine and records every statement it hands to the database.

Only the external execution is isolated: the database call is replaced by a
recorder, the migration subprocess and the change of the working directory do
nothing, and the credentials are never read. Nothing is granted and no
database is touched. The statements are printed as a JSON list on the standard
output.

Usage:
  python3 deploy/capture-provision-sql.py deploy/provision-runtime.py

The working directory must hold the files the routine reads: the policy
(`runtime-grants.policy.json`) and the credential files `runtime.env`,
`api.env` and `backup.env`.
"""
import contextlib
import importlib.util
import io
import json
import sys
from unittest.mock import patch


def main():
    if len(sys.argv) < 2:
        raise SystemExit('usage: capture-provision-sql.py <provision-runtime.py>')
    spec = importlib.util.spec_from_file_location('provision_runtime', sys.argv[1])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    statements = []

    def capture(statement, database='kamkmchess'):
        """Records a statement instead of running it against a database."""
        if statement.startswith('SELECT 1'):
            # The existence checks of the routine answer that the database,
            # the roles and the credential files are already in place.
            return '1'
        statements.append(statement)
        return ''

    module.sql = capture
    with patch.object(module.os, 'chdir'), patch.object(module.subprocess, 'run'), contextlib.redirect_stdout(io.StringIO()):
        module.main()
    print(json.dumps(statements))


if __name__ == '__main__':
    main()
