from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from nova_generator.api.dependencies import get_check_health
from nova_generator.application.use_cases.check_health import CheckHealth

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    database: Literal["ok", "unavailable"]


@router.get("/health", response_model=HealthResponse)
def health_check(
    check_health: Annotated[CheckHealth, Depends(get_check_health)],
) -> HealthResponse:
    result = check_health.execute()
    return HealthResponse(status=result.status, database=result.database)
