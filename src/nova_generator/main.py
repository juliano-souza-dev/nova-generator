from fastapi import FastAPI

from nova_generator.api.routes.health import router as health_router
from nova_generator.core.settings import get_settings


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name)
    app.include_router(health_router, prefix=settings.api_prefix)
    return app


app = create_app()

