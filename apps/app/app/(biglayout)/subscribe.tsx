import { useEffect } from 'react';
import { View, ScrollView, useWindowDimensions, ActivityIndicator } from 'react-native';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import {
  useSubscriptionPlans,
  useSubscription,
  useCreateSubscriptionCheckout,
  type SubscriptionPlan,
} from '@/lib/hooks/use-billing';
import { useAuth, openAccountDialog } from '@oxyhq/services';
import { toast } from '@oxyhq/bloom/toast';
import { useTranslation } from '@/hooks/useTranslation';
import { ArrowLeft, Check, Sparkles } from 'lucide-react-native';
import { useColorScheme } from '@/lib/useColorScheme';
import Head from 'expo-router/head';

export default function SubscribeScreen() {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const { colors } = useColorScheme();
  const isLargeScreen = width >= 768;

  const { data: plans, isLoading: plansLoading } = useSubscriptionPlans('clarity');
  const { data: subscription } = useSubscription('clarity');
  const checkoutMutation = useCreateSubscriptionCheckout();

  // Send unauthenticated users home and open the sign-in modal
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.replace('/(app)');
      openAccountDialog();
    }
  }, [authLoading, isAuthenticated, router]);

  const handleSelectPlan = async (plan: SubscriptionPlan) => {
    if (plan.isFree) return;

    try {
      const result = await checkoutMutation.mutateAsync({
        planId: plan.id,
        billingPeriod: 'monthly',
        successUrl: Linking.createURL('/'),
        cancelUrl: Linking.createURL('/(biglayout)/subscribe'),
      });

      if (result.url) {
        Linking.openURL(result.url);
      }
    } catch {
      toast.error(t('subscribe.checkoutError') || 'Failed to create checkout session');
    }
  };

  if (authLoading || plansLoading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const currentPlanId = subscription?.plan?.planId || 'free';

  return (
    <>
      <Head>
        <title>Subscribe - Oxy Station</title>
      </Head>
      <View className="flex-1 bg-background">
        {/* Header */}
        <View className="flex-row items-center gap-3 px-4 py-3 border-b border-border">
          <Button variant="ghost" size="icon" onPress={() => router.back()}>
            <ArrowLeft size={20} className="text-foreground" />
          </Button>
          <Text className="text-lg font-semibold text-foreground">
            {t('subscribe.title') || 'Upgrade to Pro'}
          </Text>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{
            padding: 24,
            maxWidth: 960,
            alignSelf: 'center',
            width: '100%',
          }}
        >
          <View className="items-center mb-8">
            <Sparkles size={32} className="text-primary mb-3" />
            <Text className="text-2xl font-bold text-foreground text-center mb-2">
              {t('subscribe.heading') || 'Choose your plan'}
            </Text>
            <Text className="text-muted-foreground text-center">
              {t('subscribe.subheading') || 'Unlock more powerful models and higher limits'}
            </Text>
          </View>

          <View className={`gap-4 ${isLargeScreen ? 'flex-row flex-wrap justify-center' : ''}`}>
            {(plans || []).map((plan) => {
              const isCurrent = plan.id === currentPlanId || (plan.isFree && currentPlanId === 'free');
              return (
                <View
                  key={plan.id}
                  className={`rounded-2xl border p-6 ${isLargeScreen ? 'w-[300px]' : 'w-full'} ${
                    plan.isFeatured ? 'border-primary bg-primary/5' : 'border-border bg-card'
                  }`}
                >
                  {plan.isFeatured && (
                    <View className="bg-primary rounded-full px-3 py-1 self-start mb-3">
                      <Text className="text-xs font-semibold text-primary-foreground">
                        {t('subscribe.recommended') || 'Recommended'}
                      </Text>
                    </View>
                  )}
                  <Text className="text-xl font-bold text-foreground mb-1">{plan.name}</Text>
                  {plan.subtitle && (
                    <Text className="text-sm text-muted-foreground mb-3">{plan.subtitle}</Text>
                  )}
                  <View className="flex-row items-baseline mb-4">
                    <Text className="text-3xl font-bold text-foreground">
                      ${plan.monthlyPrice}
                    </Text>
                    <Text className="text-muted-foreground ml-1">/mo</Text>
                  </View>
                  {plan.creditsLabel && (
                    <Text className="text-sm text-muted-foreground mb-4">{plan.creditsLabel}</Text>
                  )}
                  {plan.features?.map((group) =>
                    group.items.map((item, i) => (
                      <View key={`${group.category}-${i}`} className="flex-row items-start gap-2 mb-2">
                        <Check size={16} className="text-primary mt-0.5" />
                        <Text className="text-sm text-foreground flex-1">{item.label}</Text>
                      </View>
                    ))
                  )}
                  <Button
                    className="mt-4 rounded-full"
                    variant={plan.isFeatured ? 'default' : 'outline'}
                    disabled={isCurrent || checkoutMutation.isPending}
                    onPress={() => handleSelectPlan(plan)}
                  >
                    <Text className={plan.isFeatured ? 'text-primary-foreground font-semibold' : 'font-semibold'}>
                      {isCurrent
                        ? (t('subscribe.currentPlan') || 'Current plan')
                        : plan.isFree
                          ? (t('subscribe.free') || 'Free')
                          : (t('subscribe.subscribe') || 'Subscribe')}
                    </Text>
                  </Button>
                </View>
              );
            })}
          </View>
        </ScrollView>
      </View>
    </>
  );
}
