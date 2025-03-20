# Mastra Weather Agent

The **Mastra Weather Agent** is a travel planning tool that generates day-by-day itineraries based on weather forecasts, user preferences, and budget constraints. It leverages AI and external APIs to provide personalized travel recommendations.

## Features

- Fetches weather forecasts for a specified city and duration.
- Uses Brave Search to find local attractions, restaurants, and accommodations.
- Generates detailed itineraries including activities, meals, and lodging options.
- Adapts recommendations based on weather conditions and budget preferences.

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd mastra-weather-agent
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up environment variables in a `.env` file:
   ```env
   OPENAI_API_KEY=<your-openai-api-key>
   OPENAI_BASE_URL=<your-openai-base-url>
   OPENAI_MODEL_ID=<model-id>
   BRAVE_SEARCH_API_KEY=<your-brave-search-api-key>
   ```

## Usage

Run the main script to generate an itinerary:
```bash
npx tsx weather.ts
```

You can customize the input parameters (city, days, budget) in the `main` function of `weather.ts`.

## Example

For a 3-day budget-friendly itinerary in Bandung:
```typescript
triggerData: {
  city: "Bandung",
  days: 3,
  budget: "budget",
}
```

## Dependencies

- [dotenv](https://www.npmjs.com/package/dotenv) for environment variable management.
- [@mastra/core](https://www.npmjs.com/package/@mastra/core) for workflow and agent management.
- [@ai-sdk/openai](https://www.npmjs.com/package/@ai-sdk/openai) for AI model integration.
- [zod](https://www.npmjs.com/package/zod) for schema validation.

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.
