# City Library demo site (Doorway target): human pages over a private, switchable JSON API.
FROM public.ecr.aws/docker/library/python:3.12-slim
RUN pip install --no-cache-dir fastapi==0.142.2 uvicorn==0.54.0
WORKDIR /srv
COPY demo_sites ./demo_sites
CMD ["sh", "-c", "exec uvicorn demo_sites.city_library:app --host 0.0.0.0 --port ${PORT:-8080}"]
