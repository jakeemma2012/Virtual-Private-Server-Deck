'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Icons } from '@/components/icons';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ThemeSelector } from '@/components/themes/theme-selector';
import { Separator } from '@/components/ui/separator';

export default function SettingsPage() {
  return (
    <div className='animate-rise flex flex-1 flex-col gap-6 p-6'>
      <div>
        <h2 className='text-2xl font-bold tracking-tight'>Settings</h2>
        <p className='text-muted-foreground'>Manage your panel preferences and configuration.</p>
      </div>

      <Tabs defaultValue='general'>
        <TabsList>
          <TabsTrigger value='general'>General</TabsTrigger>
          <TabsTrigger value='appearance'>Appearance</TabsTrigger>
          <TabsTrigger value='notifications'>Notifications</TabsTrigger>
          <TabsTrigger value='api'>API Keys</TabsTrigger>
        </TabsList>

        <TabsContent value='general' className='space-y-6'>
          <Card className='hover-lift'>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
              <CardDescription>Update your account information.</CardDescription>
            </CardHeader>
            <CardContent className='space-y-4'>
              <div className='grid gap-4 md:grid-cols-2'>
                <div className='space-y-2'>
                  <Label htmlFor='name'>Name</Label>
                  <Input id='name' defaultValue='Admin' />
                </div>
                <div className='space-y-2'>
                  <Label htmlFor='email'>Email</Label>
                  <Input id='email' type='email' defaultValue='admin@vps-manager.io' />
                </div>
              </div>
              <Button>Save Changes</Button>
            </CardContent>
          </Card>

          <Card className='hover-lift'>
            <CardHeader>
              <CardTitle>Security</CardTitle>
              <CardDescription>Update your password and 2FA settings.</CardDescription>
            </CardHeader>
            <CardContent className='space-y-4'>
              <div className='grid gap-4 md:grid-cols-2'>
                <div className='space-y-2'>
                  <Label htmlFor='current-pw'>Current Password</Label>
                  <Input id='current-pw' type='password' />
                </div>
                <div className='space-y-2'>
                  <Label htmlFor='new-pw'>New Password</Label>
                  <Input id='new-pw' type='password' />
                </div>
              </div>
              <Button>Update Password</Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value='appearance' className='space-y-6'>
          <Card className='hover-lift'>
            <CardHeader>
              <CardTitle>Theme</CardTitle>
              <CardDescription>Customize the look and feel of your dashboard.</CardDescription>
            </CardHeader>
            <CardContent className='space-y-4'>
              <div className='flex items-center gap-4'>
                <Label>Color Theme</Label>
                <ThemeSelector />
              </div>
              <Separator />
              <p className='text-sm text-muted-foreground'>
                You can also press <kbd className='bg-muted rounded px-1.5 py-0.5 text-xs font-mono'>T T</kbd> to cycle themes
                or <kbd className='bg-muted rounded px-1.5 py-0.5 text-xs font-mono'>D D</kbd> to toggle dark/light mode.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value='notifications' className='space-y-6'>
          <Card className='hover-lift'>
            <CardHeader>
              <CardTitle>Notifications</CardTitle>
              <CardDescription>Configure alert and notification preferences.</CardDescription>
            </CardHeader>
            <CardContent className='space-y-4'>
              <p className='text-sm text-muted-foreground'>Notification settings will be available when backend is connected.</p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value='api' className='space-y-6'>
          <Card className='hover-lift'>
            <CardHeader>
              <CardTitle>API Keys</CardTitle>
              <CardDescription>Manage API keys for external integrations.</CardDescription>
            </CardHeader>
            <CardContent className='space-y-4'>
              <Button><Icons.add className='mr-2 size-4' />Generate New Key</Button>
              <p className='text-sm text-muted-foreground'>No API keys generated yet.</p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
