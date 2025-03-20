import "dotenv/config";
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { Step, Workflow } from "@mastra/core/workflows";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { createTool } from "@mastra/core/tools";

const openaiProvider = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

const braveSearchTool = createTool({
  id: "brave-search",
  description: "Search the web for information about a location",
  inputSchema: z.object({
    query: z.string().describe("The search query"),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        title: z.string(),
        description: z.string(),
        url: z.string(),
      })
    ),
  }),
  execute: async ({ context }) => {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY as string;
    const searchUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
      context.query
    )}&count=5`;

    const response = await fetch(searchUrl, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Brave Search API error: ${response.status}`);
    }

    const data = await response.json();

    return {
      results:
        data.web?.results.map((result: any) => ({
          title: result.title,
          description: result.description,
          url: result.url,
        })) || [],
    };
  },
});

const agent = new Agent({
  name: "Travel Planner",
  instructions: `
   You are a travel expert who creates practical day-by-day itineraries.
   
   Use the brave-search tool FIRST to find information about local attractions, activities, restaurants, and accommodations.
   THEN create one single complete itinerary. Do not show your initial draft - only show the final version.
   
   For each day, include:
   
   DAY X (DATE)
   
   WEATHER: Brief weather summary with temperature and conditions
   
   BREAKFAST: Suggest one local breakfast spot with brief description
   
   MORNING: One or two activities based on weather, with times and locations
   
   LUNCH: Suggest one local eatery with brief description
   
   AFTERNOON: One or two activities based on weather, with times and locations
   
   DINNER: Suggest one local restaurant with brief description
   
   EVENING: Optional evening activity if appropriate
   
   If the itinerary is multi-day, include ACCOMMODATION recommendations at the end. Provide options for different budget levels (Budget, Mid-range, Luxury).
   
   Adapt all recommendations to match the user's specified budget preference if provided.
   Keep all suggestions concise and practical. Adapt recommendations based on weather conditions.
   Do not include search result notes at the end of your response.
 `,
  model: openaiProvider("meta-llama/Llama-3.3-70B-Instruct-Turbo"),
  tools: { braveSearchTool },
});

const fetchWeather = new Step({
  id: "fetch-weather",
  description: "Fetches weather forecast for a given city",
  inputSchema: z.object({
    city: z.string().describe("The city to get the weather for"),
    days: z.number().describe("Number of days for the itinerary").default(3),
    budget: z.enum(["budget", "mid-range", "luxury"]).default("mid-range"),
  }),
  execute: async ({ context }) => {
    const triggerData = context?.getStepResult<{
      city: string;
      days: number;
      budget: string;
    }>("trigger");

    if (!triggerData) {
      throw new Error("Trigger data not found");
    }

    const geocodingUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
      triggerData.city
    )}&count=1`;
    const geocodingResponse = await fetch(geocodingUrl);
    const geocodingData = await geocodingResponse.json();

    if (!geocodingData.results?.[0]) {
      throw new Error(`Location '${triggerData.city}' not found`);
    }

    const { latitude, longitude, name } = geocodingData.results[0];

    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_mean,weathercode&timezone=auto`;
    const response = await fetch(weatherUrl);
    const data = await response.json();

    // Limit the forecast to the requested number of days
    const numDays = Math.min(triggerData.days, data.daily.time.length);

    const forecast = data.daily.time
      .slice(0, numDays)
      .map((date: string, index: number) => ({
        date,
        maxTemp: data.daily.temperature_2m_max[index],
        minTemp: data.daily.temperature_2m_min[index],
        precipitationChance: data.daily.precipitation_probability_mean[index],
        condition: getWeatherCondition(data.daily.weathercode[index]),
        location: name,
      }));

    return {
      forecast,
      location: name,
      days: numDays,
      budget: triggerData.budget,
    };
  },
});

const forecastSchema = z.object({
  forecast: z.array(
    z.object({
      date: z.string(),
      maxTemp: z.number(),
      minTemp: z.number(),
      precipitationChance: z.number(),
      condition: z.string(),
      location: z.string(),
    })
  ),
  location: z.string(),
  days: z.number(),
  budget: z.enum(["budget", "mid-range", "luxury"]),
});

const planItinerary = new Step({
  id: "plan-itinerary",
  description:
    "Creates a travel itinerary with activities and food recommendations",
  inputSchema: forecastSchema,
  execute: async ({ context }) => {
    const data =
      context?.getStepResult<z.infer<typeof forecastSchema>>("fetch-weather");

    if (!data) {
      throw new Error("Forecast data not found");
    }

    const { forecast, location, days, budget } = data;

    const prompt = `Create a ${days}-day itinerary for ${location} based on this weather forecast:
   ${JSON.stringify(forecast, null, 2)}
   
   Budget preference: ${budget}
   
   Include breakfast, lunch, and dinner recommendations for each day along with morning and afternoon activities. If more than 1 day, include accommodation options.
   
   Use the brave-search tool to find popular attractions, activities, restaurants, and accommodations in ${location} that match the ${budget} budget level.`;

    const response = await agent.stream([
      {
        role: "user",
        content: prompt,
      },
    ]);

    let itineraryText = "";

    for await (const chunk of response.textStream) {
      process.stdout.write(chunk);
      itineraryText += chunk;
    }

    return {
      itinerary: itineraryText,
      location,
      days,
      budget,
    };
  },
});

function getWeatherCondition(code: number): string {
  const conditions: Record<number, string> = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Foggy",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    71: "Slight snow fall",
    73: "Moderate snow fall",
    75: "Heavy snow fall",
    95: "Thunderstorm",
  };
  return conditions[code] || "Unknown";
}

const itineraryWorkflow = new Workflow({
  name: "itineraryWorkflow",
  triggerSchema: z.object({
    city: z.string().describe("The city to get the weather for"),
    days: z.number().describe("Number of days for the itinerary").default(3),
    budget: z
      .enum(["budget", "mid-range", "luxury"])
      .default("mid-range")
      .describe("Budget preference for accommodations and activities"),
  }),
})
  .step(fetchWeather)
  .then(planItinerary);

itineraryWorkflow.commit();

const mastra = new Mastra({
  workflows: {
    itineraryWorkflow,
  },
});

async function main() {
  const { start } = mastra.getWorkflow("itineraryWorkflow").createRun();

  const result = await start({
    triggerData: {
      city: "Bandung",
      days: 3,
      budget: "budget", // Can be "budget", "mid-range", or "luxury"
    },
  });

  console.log("\n \n");
  console.log(result);
}

main();
