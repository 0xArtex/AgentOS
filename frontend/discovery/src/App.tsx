import TopNav from "./components/TopNav";
import Hero from "./sections/Hero";
import HeroToIntegrations from "./sections/HeroToIntegrations";
import Integrations from "./sections/Integrations";
import IntegrationsToTools from "./sections/IntegrationsToTools";
import Tools from "./sections/Tools";

export default function App() {
  return (
    <>
      <TopNav />
      <Hero />
      <HeroToIntegrations />
      <Integrations />
      <IntegrationsToTools />
      <Tools />
    </>
  );
}
