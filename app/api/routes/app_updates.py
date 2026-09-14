"""Authenticated in-app update initiation and opaque restart-safe job status."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
import httpx
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask
from starlette.responses import JSONResponse

from app.api.transactions import transactional_route
from app.services import app_updates
from app.services.exception_capture import CapturedExceptionContext
from app.services.app_updates import AppUpdateRejected


router = APIRouter(prefix='/auth/app-update', tags=['updates'])


class AppUpdateRequest(BaseModel):
    target_version: str = Field(pattern=r'^[0-9]+\.[0-9]+\.[0-9]+$')


@router.get('/check')
def check_update():
    release = CapturedExceptionContext(httpx.HTTPError,
        boundary='app/api/routes/app_updates.py:check_update:release')
    with release:
        status = app_updates.check_for_update()
    if release.captured_exception is not None:
        raise HTTPException(status_code=503, detail='Could not reach the release server. Please try again.') from release.captured_exception
    return JSONResponse(content=status, headers={'Cache-Control': 'no-store'})


@router.post('')
@transactional_route
def start_update(body: AppUpdateRequest):
    admission = CapturedExceptionContext(AppUpdateRejected,
        boundary='app/api/routes/app_updates.py:start_update:admission')
    with admission:
        record = app_updates.create_update_job(body.target_version)
    if admission.captured_exception is not None:
        raise HTTPException(status_code=409, detail=str(admission.captured_exception)) from admission.captured_exception
    return JSONResponse(status_code=202, content=record,
                        background=BackgroundTask(app_updates.launch_update_job, record['job_id']))


@router.get('/jobs/{job_id}')
def update_status(job_id: str):
    lookup = CapturedExceptionContext(AppUpdateRejected, FileNotFoundError,
        boundary='app/api/routes/app_updates.py:update_status:lookup')
    with lookup:
        record = app_updates.read_job(job_id)
    if lookup.captured_exception is not None:
        raise HTTPException(status_code=404, detail='Update job not found') from lookup.captured_exception
    return JSONResponse(content=record, headers={'Cache-Control': 'no-store'})
