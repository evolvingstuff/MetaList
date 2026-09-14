"""Detached launcher exits before the existing updater replaces its installation."""
from __future__ import annotations

import os
import sys

from app.services.app_updates import read_job, release_update_job, update_executable, write_job
from app.services.self_update import schedule_self_update
from app.version import __version__


def run_update(job_id: str) -> None:
    record = read_job(job_id)
    assert record['status'] == 'queued'
    record = dict(record, status='preparing', pid=os.getpid(), message='Checking the update and preparing verified backups. MetaList will restart automatically.')
    write_job(record)
    # Finally records failures without intercepting internal exceptions.
    scheduled = False
    finished = False
    try:
        result = schedule_self_update(
            current_version=__version__, metalist_executable=str(update_executable()),
            current_pid=os.getpid(), platform_name=sys.platform, environ=os.environ,
            expected_target_version=str(record['target_version']),
        )
        scheduled = result.update_scheduled
        if scheduled:
            status = 'installing'
        else:
            status = 'complete'
        write_job(dict(record, status=status, message=result.message))
        finished = True
    finally:
        if not finished:
            write_job(dict(record, status='failed', message='Update failed. See the update log for the cause.'))
        if not scheduled:
            release_update_job(job_id)


if __name__ == '__main__':
    assert len(sys.argv) == 2, 'Usage: python -m app.services.app_update_worker JOB_ID'
    run_update(sys.argv[1])
