import re
import time
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, Request

from nova_generator.api.routes.editorial import router as editorial_router
from nova_generator.api.routes.health import router as health_router
from nova_generator.api.routes.jobs import router as jobs_router
from nova_generator.api.routes.projects import router as projects_router
from nova_generator.api.routes.voices import router as voices_router
from nova_generator.core.observability import configure_json_logging
from nova_generator.core.settings import get_settings


@asynccontextmanager
async def lifespan(_app: FastAPI):
    get_settings().validate_runtime()
    get_settings().ensure_database_directory()
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    logger = configure_json_logging()
    app = FastAPI(title=settings.app_name, lifespan=lifespan)

    @app.middleware("http")
    async def correlate_request(request: Request, call_next):
        supplied = request.headers.get("X-Request-ID", "")
        request_id = supplied if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", supplied) else uuid4().hex
        request.state.request_id = request_id
        started = time.monotonic()
        try:
            response = await call_next(request)
        except Exception:
            logger.exception("request_failed", extra={"request_id": request_id})
            raise
        response.headers["X-Request-ID"] = request_id
        route = request.scope.get("route")
        logger.info(
            "request_completed",
            extra={
                "request_id": request_id,
                "method": request.method,
                "route": getattr(route, "path", "unmatched"),
                "status": response.status_code,
                "duration_ms": int((time.monotonic() - started) * 1000),
            },
        )
        return response

    app.include_router(health_router, prefix=settings.api_prefix)
    app.include_router(editorial_router, prefix=settings.api_prefix)
    app.include_router(jobs_router, prefix=settings.api_prefix)
    app.include_router(projects_router, prefix=settings.api_prefix)
    app.include_router(voices_router, prefix=settings.api_prefix)
    return app


app = create_app()
