FROM public.ecr.aws/docker/library/python:3.11-slim

WORKDIR /app

COPY ../streamlit-docker-app/requirements.txt .
RUN pip install -r requirements.txt

COPY ../streamlit-docker-app/app/app.py .

CMD ["streamlit", "run", "app.py"]

