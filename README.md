# SAANS — Smart Air Assessment and Analytics System 🌿

**Making air-quality information easier to understand.**

SAANS is a web-based air-quality monitoring system designed to help users explore local pollution conditions through pollutant measurements, an estimated Air Quality Index (AQI), historical records, and AI-powered conversational guidance.

Built for the **AWS Environmental Hacks** challenge, SAANS combines environmental data with cloud computing and generative AI to make air-quality information more accessible.

## 🌍 Project Overview

Air pollution affects people's health, daily activities, and quality of life. However, raw environmental data can be difficult to interpret.

SAANS aims to bridge this gap by presenting important air-quality measurements through a simple web dashboard and providing an AI-powered chat interface for contextual air-quality guidance.

## ✨ Features

- **Air Quality Dashboard:** Displays air-quality measurements for a selected location.
- **Pollutant Monitoring:** Shows PM2.5, PM10, nitrogen dioxide (NO₂), and ozone (O₃) readings.
- **Estimated AQI Indicator:** Presents an estimated air-quality index based on available pollutant data.
- **Historical Air Quality:** Stores and retrieves previous air-quality readings for review.
- **AI-Powered Chat:** Allows users to ask questions about air quality and receive contextual responses.
- **Location-Based Data:** Retrieves air-quality information for supported geographic coordinates.

## 🛠️ Technology Stack

| Component | Technology |
|---|---|
| Frontend | HTML, CSS, JavaScript |
| Backend | Python |
| Cloud Hosting | AWS Amplify |
| API Management | Amazon API Gateway |
| Serverless Computing | AWS Lambda |
| Database | Amazon DynamoDB |
| AI Integration | Amazon Bedrock Mantle API |
| Environmental Data | Open-Meteo Air Quality API |
| Version Control | Git and GitHub |

## 🏗️ Architecture

```text
             User
              |
              v
     SAANS Web Dashboard
      HTML, CSS, JavaScript
              |
              v
      Amazon API Gateway
              |
              v
        AWS Lambda
        (Python Backend)
          /    |     \
         v     v      v
    Open-    DynamoDB  Amazon
    Meteo    History  Bedrock
      |
      v
 Air Quality Data
```

**Deployment:** The frontend is hosted on AWS Amplify, while API Gateway routes requests to the Lambda backend. DynamoDB stores historical readings, and Amazon Bedrock supports the AI chat functionality.

## ☁️ AWS Services Used

### AWS Amplify
Hosts the web frontend and supports deployment from the project's GitHub repository.

### Amazon API Gateway
Provides HTTP endpoints through which the frontend accesses backend functionality.

### AWS Lambda
Runs the Python backend, retrieves environmental data, manages historical records, and handles AI chat requests.

### Amazon DynamoDB
Stores historical air-quality readings for subsequent retrieval.

### Amazon Bedrock
Supports conversational air-quality guidance through the Bedrock Mantle API integration.

## 🌱 Environmental Impact

SAANS aims to make air-quality information easier to access and understand. By bringing pollutant measurements, historical information, and conversational guidance together, the project provides a foundation for more informed decisions about environmental exposure.

Potential future applications include school-safety guidance, indoor-air monitoring, pollution forecasts, community reporting, and configurable email alerts. These are planned extensions, not features claimed as implemented in the current version.

## 🚀 Getting Started

### Prerequisites

- Python 3.10 or later
- An AWS account
- An existing AWS Lambda function and API Gateway configuration
- An Amazon DynamoDB table configured for air-quality history
- Required AWS permissions
- A Bedrock Mantle API key if using the AI chat integration

### Project Structure

SAANS/
├── frontend/
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── sw.js
├── backend/
│   └── lambda_function.py
├── amplify.yml
└── README.md
```

*The service worker file `sw.js` is optional if offline support has not been added to your deployed version.*

### Deployment

1. Push the frontend files to the GitHub repository.
2. Connect the repository to AWS Amplify and configure the frontend build settings.
3. Deploy the Python backend to AWS Lambda.
4. Configure API Gateway routes and integrate them with the Lambda function.
5. Configure the DynamoDB table and the required Lambda environment variables and IAM permissions.
6. Configure the Bedrock credentials securely in Lambda if AI chat is enabled.
7. Open the deployed website and test the dashboard, history, and chat features.

**Security:** Never commit API keys, passwords, or other secrets to GitHub. Store sensitive credentials in secure backend configuration.

## ⚠️ Limitations

- The AQI shown is an estimate and should not be treated as an official CPCB AQI measurement.
- Air-quality readings depend on the availability, coverage, and freshness of the external data provider.
- AI-generated guidance is informational and should not replace official public-health advisories.
- Forecasting, automated notifications, indoor-air sensor integration, and community reporting are future enhancements unless separately implemented and tested.

## 🔮 Future Scope

- Air-quality forecasting and pollution trend analysis
- School-oriented safety guidance
- Indoor-air monitoring and sensor integration
- Community pollution reports
- Multilingual support
- Configurable email alerts
- Better offline functionality

## 🤝 Contributing

Contributions, suggestions, and ideas for improving accessible environmental technology are welcome.

1. Fork the repository.
2. Create a feature branch.
3. Commit your changes.
4. Open a pull request describing your improvements.

---

**SAANS — Smart Air Assessment and Analytics System**

*Understand the air. Make informed decisions.*
